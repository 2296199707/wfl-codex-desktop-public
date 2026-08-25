import assert from "node:assert/strict";
import test from "node:test";
import { certificateCoversHost, inspectPublicOriginHealth, isAcceptableOriginHttpStatus } from "../lib/public-origin-health.mjs";

test("certificate coverage accepts exact and one-label wildcard SANs", () => {
  assert.equal(certificateCoversHost({ subjectaltname: "DNS:wflai.chat, DNS:*.preview.wflai.chat" }, "wflai.chat"), true);
  assert.equal(certificateCoversHost({ subjectaltname: "DNS:wflai.chat, DNS:*.preview.wflai.chat" }, "preview-session-a.preview.wflai.chat"), true);
  assert.equal(certificateCoversHost({ subjectaltname: "DNS:*.preview.wflai.chat" }, "nested.preview-session-a.preview.wflai.chat"), false);
});

test("origin health checks DNS, TLS coverage, and HTTPS without following redirects", async () => {
  const requests = [];
  const result = await inspectPublicOriginHealth({
    mode: "confirmed",
    publicOrigin: "https://wflai.chat",
    previewBaseDomain: "preview.wflai.chat",
    previewOrigins: ["https://preview-1.preview.wflai.chat"],
    isolation: "pool",
  }, {
    lookup: async (hostname) => [{ address: hostname === "wflai.chat" ? "203.0.113.8" : "203.0.113.9", family: 4 }],
    tlsProbe: async (hostname) => ({
      authorized: true,
      subjectaltname: `DNS:${hostname}`,
      valid_to: "2099-01-01T00:00:00Z",
    }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response("", { status: 302 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.origins.length, 2);
  assert.equal(result.origins[0].http.status, 302);
  assert.equal(requests.every((request) => request.options.redirect === "manual"), true);
});

test("origin health accepts an authentication challenge after DNS and TLS succeed", async () => {
  const result = await inspectPublicOriginHealth({
    mode: "confirmed",
    publicOrigin: "https://wflai.chat",
    previewOrigins: [],
    isolation: "pool",
  }, {
    lookup: async () => [{ address: "203.0.113.8", family: 4 }],
    tlsProbe: async () => ({
      authorized: true,
      subjectaltname: "DNS:wflai.chat",
      valid_to: "2099-01-01T00:00:00Z",
    }),
    fetchImpl: async () => new Response("Authentication required", { status: 401 }),
  });
  assert.equal(isAcceptableOriginHttpStatus(401), true);
  assert.equal(isAcceptableOriginHttpStatus(403), false);
  assert.equal(isAcceptableOriginHttpStatus(500), false);
  assert.equal(result.ok, true);
  assert.equal(result.origins[0].http.ok, true);
  assert.equal(result.origins[0].http.detail, "HTTPS 响应正常（需要认证）");
});

test("origin health rejects DNS answers in private address space", async () => {
  const result = await inspectPublicOriginHealth({
    mode: "confirmed",
    publicOrigin: "https://wflai.chat",
    previewOrigins: [],
    isolation: "pool",
  }, {
    lookup: async () => [{ address: "10.0.0.8", family: 4 }],
    tlsProbe: async () => { throw new Error("must not connect"); },
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.origins[0].dns.ok, false);
});
