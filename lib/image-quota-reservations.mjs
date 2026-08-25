const MAX_KEY_LENGTH = 256;

/**
 * Process-local quota reservations for image jobs.
 *
 * Every mutation is synchronous. In Node's event loop this makes the
 * read/check/write sequence an atomic critical section for one owner without
 * imposing a process-wide lock on unrelated owners. Persistent disk usage is
 * deliberately supplied by the caller; only live job reservations are kept
 * here, so an empty store after a service restart is correct.
 */
export class ImageQuotaReservations {
  constructor() {
    this.owners = new Map();
    this.closed = false;
  }

  reserve({ ownerId, jobId, bytes, currentUsedBytes, limitBytes } = {}) {
    this.assertOpen();
    const ownerKey = normalizeKey(ownerId, "ownerId");
    const jobKey = normalizeKey(jobId, "jobId");
    const requestedBytes = nonNegativeSafeInteger(bytes, "bytes");
    const usedBytes = nonNegativeSafeInteger(currentUsedBytes, "currentUsedBytes");
    const quotaBytes = nonNegativeSafeInteger(limitBytes, "limitBytes");
    const owner = this.owners.get(ownerKey);
    const existing = owner?.jobs.get(jobKey) || null;

    if (existing && existing.reservedBytes !== requestedBytes) {
      throw reservationError(
        409,
        "IMAGE_QUOTA_RESERVATION_CONFLICT",
        "图片任务已使用不同的空间上限完成预留",
      );
    }

    const reservedBytes = existing
      ? owner.totalReservedBytes
      : checkedAdd(owner?.totalReservedBytes || 0, requestedBytes, "reservedBytes");
    assertWithinQuota({ usedBytes, reservedBytes, requestedBytes, quotaBytes });
    if (existing) return existing;

    const reservation = Object.freeze({
      ownerId: ownerKey,
      jobId: jobKey,
      reservedBytes: requestedBytes,
    });
    const target = owner || { jobs: new Map(), totalReservedBytes: 0 };
    target.jobs.set(jobKey, reservation);
    target.totalReservedBytes = reservedBytes;
    if (!owner) this.owners.set(ownerKey, target);
    return reservation;
  }

  settle({ ownerId, jobId, actualBytes } = {}) {
    const ownerKey = normalizeKey(ownerId, "ownerId");
    const jobKey = normalizeKey(jobId, "jobId");
    const committedBytes = nonNegativeSafeInteger(actualBytes, "actualBytes");
    const owner = this.owners.get(ownerKey);
    const reservation = owner?.jobs.get(jobKey) || null;
    if (!reservation) return null;
    if (committedBytes > reservation.reservedBytes) {
      throw reservationError(
        413,
        "IMAGE_QUOTA_RESERVATION_EXCEEDED",
        "图片任务的实际输出超过预留空间上限",
        {
          reservedBytes: reservation.reservedBytes,
          actualBytes: committedBytes,
        },
      );
    }
    this.remove(ownerKey, jobKey, owner, reservation);
    return Object.freeze({
      ownerId: ownerKey,
      jobId: jobKey,
      reservedBytes: reservation.reservedBytes,
      actualBytes: committedBytes,
      releasedBytes: reservation.reservedBytes - committedBytes,
    });
  }

  release({ ownerId, jobId } = {}) {
    const ownerKey = normalizeKey(ownerId, "ownerId");
    const jobKey = normalizeKey(jobId, "jobId");
    const owner = this.owners.get(ownerKey);
    const reservation = owner?.jobs.get(jobKey) || null;
    if (!reservation) return false;
    this.remove(ownerKey, jobKey, owner, reservation);
    return true;
  }

  has({ ownerId, jobId } = {}) {
    const ownerKey = normalizeKey(ownerId, "ownerId");
    const jobKey = normalizeKey(jobId, "jobId");
    return this.owners.get(ownerKey)?.jobs.has(jobKey) === true;
  }

  snapshot(ownerId = null) {
    if (ownerId != null) {
      const ownerKey = normalizeKey(ownerId, "ownerId");
      return ownerSnapshot(ownerKey, this.owners.get(ownerKey));
    }
    const owners = [...this.owners.entries()]
      .map(([ownerKey, owner]) => ownerSnapshot(ownerKey, owner));
    return Object.freeze({
      closed: this.closed,
      ownerCount: owners.length,
      reservationCount: owners.reduce((total, owner) => total + owner.reservationCount, 0),
      owners: Object.freeze(owners),
    });
  }

  close() {
    if (this.closed) return false;
    this.closed = true;
    this.owners.clear();
    return true;
  }

  assertOpen() {
    if (this.closed) {
      throw reservationError(
        503,
        "IMAGE_QUOTA_RESERVATIONS_CLOSED",
        "图片空间预留组件已关闭",
      );
    }
  }

  remove(ownerKey, jobKey, owner, reservation) {
    owner.jobs.delete(jobKey);
    owner.totalReservedBytes -= reservation.reservedBytes;
    if (!Number.isSafeInteger(owner.totalReservedBytes) || owner.totalReservedBytes < 0) {
      throw reservationError(500, "IMAGE_QUOTA_RESERVATION_CORRUPT", "图片空间预留状态无效");
    }
    if (owner.jobs.size === 0) this.owners.delete(ownerKey);
  }
}

function ownerSnapshot(ownerId, owner) {
  const reservations = owner ? Object.freeze([...owner.jobs.values()]) : Object.freeze([]);
  return Object.freeze({
    ownerId,
    totalReservedBytes: owner?.totalReservedBytes || 0,
    reservationCount: reservations.length,
    reservations,
  });
}

function assertWithinQuota({ usedBytes, reservedBytes, requestedBytes, quotaBytes }) {
  if (usedBytes > quotaBytes || reservedBytes > quotaBytes - usedBytes) {
    throw reservationError(
      413,
      "IMAGE_QUOTA_EXCEEDED",
      "图片任务预留空间后将超过用户硬盘配额",
      {
        currentUsedBytes: usedBytes,
        reservedBytes,
        requestedBytes,
        limitBytes: quotaBytes,
      },
    );
  }
}

function checkedAdd(left, right, label) {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw reservationError(400, "INVALID_IMAGE_QUOTA_BYTES", `${label} 超出安全整数范围`);
  }
  return left + right;
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw reservationError(400, "INVALID_IMAGE_QUOTA_BYTES", `${label} 必须是非负安全整数`);
  }
  return value;
}

function normalizeKey(value, label) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > MAX_KEY_LENGTH) {
    throw reservationError(400, "INVALID_IMAGE_QUOTA_RESERVATION_KEY", `${label} 无效`);
  }
  return key;
}

function reservationError(statusCode, code, message, metadata = null) {
  return Object.assign(new Error(message), {
    statusCode,
    code,
    retryable: false,
    ...(metadata || {}),
  });
}
