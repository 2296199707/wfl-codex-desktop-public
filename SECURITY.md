# Security policy

WFL Codex Web Workspace controls local files, shell commands, account credentials,
browser sessions, systemd services, and optional SSH access. Treat every
deployment as a privileged administration surface and run it only on a
dedicated or otherwise isolated server.

## Reporting a vulnerability

Do not disclose vulnerabilities, credentials, access URLs, server addresses,
logs, screenshots containing account data, or proof-of-concept exploits in a
public issue.

Use the repository's private vulnerability reporting flow:

<https://github.com/2296199707/wfl-codex-desktop-public/security/advisories/new>

Include the affected version or commit, impact, prerequisites, reproduction
steps, and a minimal proof of concept with all secrets and infrastructure
details removed. Please allow a reasonable period for validation and a
coordinated fix before public disclosure.

If private vulnerability reporting is unavailable, open a public issue that
contains only the sentence "Security contact requested." Do not include
technical details until the repository owner provides a private channel.

## Supported code

Security fixes target the latest public release and the current `main` branch.
Older snapshots may not receive backports. A commit on `main` is source code,
not a formal release, unless it is also identified by the repository's
documented release process.

## Deployment baseline

- Keep ports `4317` through `4321` bound to loopback. Publish only a reviewed
  HTTPS gateway or a local SSH forwarding endpoint.
- Use a dedicated server. The production service intentionally needs
  privileged access for Codex tools, systemd deployment, and recovery.
- Give every deployment its own credentials. Never reuse Deploy Keys, API
  tokens, provider secrets, browser profiles, or backup recovery keys.
- Keep generated state, uploads, account stores, login profiles, backups, and
  `.codex-package.json` outside commits.
- Review all changes to authentication, authorization, path validation,
  command execution, proxying, uploads, restore, update, and SSH code as
  security-sensitive.
- Rotate exposed credentials immediately. Rewriting Git history does not make
  a credential safe again.

This policy is not a guarantee of support or a warranty. The WFL Codex Web Workspace
code is provided under the terms of the MIT License. Separately licensed
components retain the terms documented in the repository notices.
