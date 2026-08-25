import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCaptureAddresses,
  isBlockedAddress,
  normalizeCaptureUrl,
} from "../lib/preview-capture-policy.mjs";

test("capture policy only accepts configured preview Origins and signed preview paths", () => {
  const url = normalizeCaptureUrl("https://preview-1.example.test/preview/token/index.html", {
    allowedOrigins: ["https://preview-1.example.test"],
  });
  assert.equal(url.origin, "https://preview-1.example.test");
  assert.equal(normalizeCaptureUrl("/preview/token/index.html", {
    baseOrigin: "http://127.0.0.1:4317",
    allowLoopback: true,
  }).origin, "http://127.0.0.1:4317");
  for (const value of [
    "https://attacker.example.test/preview/token/index.html",
    "https://preview-1.example.test/",
    "file:///tmp/game.html",
    "https://user:pass@preview-1.example.test/preview/token/index.html",
  ]) {
    assert.throws(() => normalizeCaptureUrl(value, {
      allowedOrigins: ["https://preview-1.example.test"],
    }), /截图/);
  }
});

test("capture SSRF policy rejects private, loopback, link-local and multicast addresses", () => {
  for (const address of ["0.0.0.0", "10.0.0.2", "127.0.0.1", "169.254.1.1", "192.168.1.2", "224.0.0.1", "::1", "fc00::1", "fe80::1", "ff02::1"]) {
    assert.equal(isBlockedAddress(address), true, address);
    assert.throws(() => assertCaptureAddresses([address]), /限制/);
  }
  assert.equal(isBlockedAddress("127.0.0.1", { allowLoopback: true }), false);
  assert.doesNotThrow(() => assertCaptureAddresses(["127.0.0.1"], { allowLoopback: true }));
  assert.doesNotThrow(() => assertCaptureAddresses(["203.0.113.10"]));
});

