#!/usr/bin/env node
import dns from "node:dns/promises";
import process from "node:process";
import {
  relativeSubDomain,
  TencentCloudCredentialStore,
  TencentCloudDnsClient,
} from "../lib/tencent-cloud-dns.mjs";

const stateDirectory = optionValue("--state-dir") || process.env.WFL_TENCENT_DNS_STATE_DIR;
const certificateDomain = String(process.env.CERTBOT_DOMAIN || "").replace(/^\*\./, "");
const validation = String(process.env.CERTBOT_VALIDATION || "");
if (!stateDirectory || !certificateDomain || !validation) {
  console.error("缺少 Certbot 腾讯云 DNS 验证环境");
  process.exit(2);
}
const store = await new TencentCloudCredentialStore(stateDirectory).initialize();
const credentials = store.credentials();
const client = new TencentCloudDnsClient(credentials);
const challengeHost = `_acme-challenge.${certificateDomain}`;
const subDomain = relativeSubDomain(challengeHost, credentials.zoneDomain);
const result = await client.createTxtChallenge({
  zoneDomain: credentials.zoneDomain,
  subDomain,
  value: validation,
  ttl: 600,
});
const propagationMs = boundedDuration(process.env.WFL_TENCENT_DNS_PROPAGATION_MS, 120_000, 15_000, 180_000);
try {
  await waitForTxt(challengeHost, validation, propagationMs);
} catch (error) {
  await client.deleteRecord({ zoneDomain: credentials.zoneDomain, recordId: result.recordId }).catch(() => {});
  throw error;
}
// Certbot forwards auth-hook stdout to the cleanup hook as CERTBOT_AUTH_OUTPUT.
console.log(JSON.stringify({ recordId: result.recordId, zoneDomain: credentials.zoneDomain }));

function boundedDuration(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(Math.max(number, minimum), maximum) : fallback;
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function waitForTxt(hostname, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const values = (await dns.resolveTxt(hostname)).map((parts) => parts.join(""));
      if (values.includes(expected)) return;
    } catch {
      // DNSPod records can take a short time to reach recursive resolvers.
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`DNS TXT 记录 ${hostname} 在 ${Math.ceil(timeoutMs / 1000)} 秒内未传播`);
}
