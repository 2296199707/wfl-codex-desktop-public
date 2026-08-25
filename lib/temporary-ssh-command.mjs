export function temporarySshCommandArguments(record) {
  if (record.authMode === "password-control") {
    return [
      "-S", record.controlPath,
      "-p", String(record.port),
      "-o", "PreferredAuthentications=none",
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
      "-o", "PubkeyAuthentication=no",
      `${record.username}@${record.host}`,
    ];
  }
  return [
    "-i", record.privateKeyPath,
    "-p", String(record.port),
    "-o", "IdentitiesOnly=yes",
    "-o", `UserKnownHostsFile=${record.knownHostsPath}`,
    "-o", "StrictHostKeyChecking=yes",
    `${record.username}@${record.host}`,
  ];
}
