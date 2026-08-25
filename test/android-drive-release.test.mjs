import assert from "node:assert/strict";
import test from "node:test";
import {
  ANDROID_DRIVE_BUILD_LIMITS,
  androidDriveBuildSystemdArguments,
  androidDriveGradleArguments,
  getAndroidDriveBuildLimits,
  parseCertificateSha256,
  validateAndroidDriveSigningPassword,
} from "../lib/android-drive-release.mjs";

test("bounds Android build resources before starting Gradle", () => {
  const gradleArgs = androidDriveGradleArguments();
  const systemd = androidDriveBuildSystemdArguments("android-drive-test-123");
  assert.ok(gradleArgs.includes("-Dorg.gradle.workers.max=2"));
  assert.ok(gradleArgs.includes("-Dorg.gradle.parallel=false"));
  assert.ok(gradleArgs.some((value) => value.includes("-Xmx1536m")));
  assert.ok(systemd.args.includes("--scope"));
  assert.ok(systemd.args.includes(`--property=MemoryMax=${ANDROID_DRIVE_BUILD_LIMITS.memoryMax}`));
  assert.ok(systemd.args.includes(`--property=CPUQuota=${ANDROID_DRIVE_BUILD_LIMITS.cpuQuota}`));
  assert.ok(systemd.args.includes(`--property=TasksMax=${ANDROID_DRIVE_BUILD_LIMITS.tasksMax}`));
  assert.match(systemd.unit, /^wfl-codex-android-build-/u);
});

test("accepts bounded Android build limit overrides", () => {
  const names = [
    "WFL_ANDROID_BUILD_MEMORY_MAX_MIB",
    "WFL_ANDROID_BUILD_MEMORY_HIGH_MIB",
    "WFL_ANDROID_BUILD_GRADLE_HEAP_MIB",
    "WFL_ANDROID_BUILD_WORKERS",
    "WFL_ANDROID_BUILD_CPU_QUOTA_PERCENT",
    "WFL_ANDROID_BUILD_TASKS_MAX",
    "WFL_ANDROID_BUILD_SWAP_MAX_MIB",
    "WFL_ANDROID_BUILD_GO_MEMORY_MIB",
    "WFL_ANDROID_BUILD_TIMEOUT_MINUTES",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.WFL_ANDROID_BUILD_MEMORY_MAX_MIB = "4096";
    process.env.WFL_ANDROID_BUILD_MEMORY_HIGH_MIB = "3072";
    process.env.WFL_ANDROID_BUILD_GRADLE_HEAP_MIB = "3072";
    process.env.WFL_ANDROID_BUILD_WORKERS = "6";
    process.env.WFL_ANDROID_BUILD_CPU_QUOTA_PERCENT = "600";
    process.env.WFL_ANDROID_BUILD_TASKS_MAX = "512";
    process.env.WFL_ANDROID_BUILD_SWAP_MAX_MIB = "512";
    process.env.WFL_ANDROID_BUILD_GO_MEMORY_MIB = "1024";
    process.env.WFL_ANDROID_BUILD_TIMEOUT_MINUTES = "45";
    const limits = getAndroidDriveBuildLimits();
    assert.equal(limits.memoryMaxMiB, 4096);
    assert.equal(limits.memoryHighMiB, 3072);
    assert.equal(limits.gradleHeapMiB, 3072);
    assert.equal(limits.gradleWorkersCount, 6);
    assert.equal(limits.cpuQuotaPercent, 600);
    assert.equal(limits.tasksMaxCount, 512);
    assert.equal(limits.timeoutMinutes, 45);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("parses keytool and apksigner SHA-256 certificate output", () => {
  const digest = "e058d82f8a95d8cfa0dde29b842ceab82f4be46c91d674a4ef0692297fc874e2";
  const colonDigest = digest.match(/../g).join(":").toUpperCase();
  assert.equal(
    parseCertificateSha256(`Certificate fingerprints:\n\t SHA256: ${colonDigest}`),
    digest,
  );
  assert.equal(
    parseCertificateSha256(`Signer #1 certificate SHA-256 digest: ${digest}\nSigner #1 certificate SHA-1 digest: 00:11`),
    digest,
  );
  assert.equal(parseCertificateSha256("Signer #1 certificate SHA-1 digest: 00:11"), null);
});

test("requires a usable Android signing password", () => {
  assert.equal(validateAndroidDriveSigningPassword("A-secure-drive-pass"), "A-secure-drive-pass");
  assert.throws(() => validateAndroidDriveSigningPassword("too-short"), /16-256/);
  assert.throws(() => validateAndroidDriveSigningPassword(`valid-prefix\u0000-invalid`), /控制字符/);
});
