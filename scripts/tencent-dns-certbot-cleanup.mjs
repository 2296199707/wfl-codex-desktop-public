#!/usr/bin/env node
import process from "node:process";
import { TencentCloudCredentialStore, TencentCloudDnsClient } from "../lib/tencent-cloud-dns.mjs";

const stateDirectory = optionValue("--state-dir") || process.env.WFL_TENCENT_DNS_STATE_DIR;
if (!stateDirectory) process.exit(0);
let output;
try {
  output = JSON.parse(process.env.CERTBOT_AUTH_OUTPUT || "null");
} catch {
  output = null;
}
if (!Number.isSafeInteger(Number(output?.recordId)) || Number(output.recordId) <= 0) process.exit(0);
const store = await new TencentCloudCredentialStore(stateDirectory).initialize();
const credentials = store.credentials();
const client = new TencentCloudDnsClient(credentials);
await client.deleteRecord({
  zoneDomain: output.zoneDomain || credentials.zoneDomain,
  recordId: Number(output.recordId),
});

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
