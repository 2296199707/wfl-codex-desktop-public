import assert from "node:assert/strict";
import test from "node:test";
import { ImageQuotaReservations } from "../lib/image-quota-reservations.mjs";

test("image quota reservations atomically include all live jobs for one owner", async () => {
  const reservations = new ImageQuotaReservations();
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => reservations.reserve({
      ownerId: "owner-a",
      jobId: "job-1",
      bytes: 30,
      currentUsedBytes: 60,
      limitBytes: 100,
    })),
    Promise.resolve().then(() => reservations.reserve({
      ownerId: "owner-a",
      jobId: "job-2",
      bytes: 30,
      currentUsedBytes: 60,
      limitBytes: 100,
    })),
  ]);

  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  const rejected = attempts.find((entry) => entry.status === "rejected");
  assert.equal(rejected.reason.code, "IMAGE_QUOTA_EXCEEDED");
  assert.equal(reservations.snapshot("owner-a").totalReservedBytes, 30);
  assert.equal(reservations.snapshot("owner-a").reservationCount, 1);
});

test("repeated reservation is idempotent and revalidates without counting itself twice", () => {
  const reservations = new ImageQuotaReservations();
  const first = reservations.reserve({
    ownerId: "owner-a",
    jobId: "job-1",
    bytes: 40,
    currentUsedBytes: 50,
    limitBytes: 100,
  });
  const repeated = reservations.reserve({
    ownerId: "owner-a",
    jobId: "job-1",
    bytes: 40,
    currentUsedBytes: 55,
    limitBytes: 100,
  });
  assert.strictEqual(repeated, first);
  assert.equal(reservations.snapshot("owner-a").totalReservedBytes, 40);

  assert.throws(() => reservations.reserve({
    ownerId: "owner-a",
    jobId: "job-1",
    bytes: 40,
    currentUsedBytes: 61,
    limitBytes: 100,
  }), (error) => error.code === "IMAGE_QUOTA_EXCEEDED");
  assert.throws(() => reservations.reserve({
    ownerId: "owner-a",
    jobId: "job-1",
    bytes: 39,
    currentUsedBytes: 50,
    limitBytes: 100,
  }), (error) => error.code === "IMAGE_QUOTA_RESERVATION_CONFLICT");
  assert.equal(reservations.snapshot("owner-a").totalReservedBytes, 40);
});

test("owners are independent even when job ids are equal", () => {
  const reservations = new ImageQuotaReservations();
  reservations.reserve({
    ownerId: "owner-a",
    jobId: "same-job",
    bytes: 70,
    currentUsedBytes: 20,
    limitBytes: 100,
  });
  reservations.reserve({
    ownerId: "owner-b",
    jobId: "same-job",
    bytes: 70,
    currentUsedBytes: 20,
    limitBytes: 100,
  });
  assert.equal(reservations.snapshot().ownerCount, 2);
  assert.equal(reservations.snapshot().reservationCount, 2);
});

test("settlement releases the unused upper bound and oversized output remains reserved", () => {
  const reservations = new ImageQuotaReservations();
  reservations.reserve({
    ownerId: "owner-a",
    jobId: "job-1",
    bytes: 100,
    currentUsedBytes: 0,
    limitBytes: 100,
  });
  assert.throws(() => reservations.settle({
    ownerId: "owner-a",
    jobId: "job-1",
    actualBytes: 101,
  }), (error) => error.code === "IMAGE_QUOTA_RESERVATION_EXCEEDED");
  assert.equal(reservations.has({ ownerId: "owner-a", jobId: "job-1" }), true);

  assert.deepEqual(reservations.settle({
    ownerId: "owner-a",
    jobId: "job-1",
    actualBytes: 64,
  }), {
    ownerId: "owner-a",
    jobId: "job-1",
    reservedBytes: 100,
    actualBytes: 64,
    releasedBytes: 36,
  });
  assert.equal(reservations.snapshot("owner-a").totalReservedBytes, 0);
  assert.equal(reservations.settle({ ownerId: "owner-a", jobId: "job-1", actualBytes: 64 }), null);
});

test("failure, cancellation, and close can release every live reservation", () => {
  const reservations = new ImageQuotaReservations();
  for (const jobId of ["failed", "canceled", "closing"]) {
    reservations.reserve({
      ownerId: "owner-a",
      jobId,
      bytes: 10,
      currentUsedBytes: 0,
      limitBytes: 100,
    });
  }
  assert.equal(reservations.release({ ownerId: "owner-a", jobId: "failed" }), true);
  assert.equal(reservations.release({ ownerId: "owner-a", jobId: "failed" }), false);
  assert.equal(reservations.release({ ownerId: "owner-a", jobId: "canceled" }), true);
  assert.equal(reservations.snapshot().reservationCount, 1);
  assert.equal(reservations.close(), true);
  assert.equal(reservations.close(), false);
  assert.equal(reservations.snapshot().reservationCount, 0);
  assert.throws(() => reservations.reserve({
    ownerId: "owner-a",
    jobId: "new-job",
    bytes: 1,
    currentUsedBytes: 0,
    limitBytes: 100,
  }), (error) => error.code === "IMAGE_QUOTA_RESERVATIONS_CLOSED");
});

test("quota byte fields reject unsafe values and comparisons do not overflow", () => {
  const reservations = new ImageQuotaReservations();
  const base = {
    ownerId: "owner-a",
    jobId: "job-1",
    bytes: 1,
    currentUsedBytes: 0,
    limitBytes: Number.MAX_SAFE_INTEGER,
  };
  for (const patch of [
    { bytes: -1 },
    { bytes: 1.5 },
    { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { currentUsedBytes: Number.NaN },
    { limitBytes: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(
      () => reservations.reserve({ ...base, ...patch }),
      (error) => error.code === "INVALID_IMAGE_QUOTA_BYTES",
    );
  }
  assert.throws(() => reservations.reserve({
    ...base,
    bytes: 6,
    currentUsedBytes: Number.MAX_SAFE_INTEGER - 5,
  }), (error) => (
    error.code === "IMAGE_QUOTA_EXCEEDED"
    && error.currentUsedBytes === Number.MAX_SAFE_INTEGER - 5
  ));
  assert.equal(reservations.snapshot().reservationCount, 0);

  reservations.reserve({
    ownerId: "owner-overflow",
    jobId: "fills-safe-range",
    bytes: Number.MAX_SAFE_INTEGER,
    currentUsedBytes: 0,
    limitBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.throws(() => reservations.reserve({
    ownerId: "owner-overflow",
    jobId: "would-overflow",
    bytes: 1,
    currentUsedBytes: 0,
    limitBytes: Number.MAX_SAFE_INTEGER,
  }), (error) => error.code === "INVALID_IMAGE_QUOTA_BYTES");
  assert.equal(
    reservations.snapshot("owner-overflow").totalReservedBytes,
    Number.MAX_SAFE_INTEGER,
  );
});
