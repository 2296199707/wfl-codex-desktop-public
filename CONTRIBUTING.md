# Contributing

Thank you for helping improve WFL Codex Web Workspace.

## Before opening a change

- Use a public issue for ordinary bugs and proposals.
- Follow [SECURITY.md](SECURITY.md) for vulnerabilities. Never place secrets,
  private infrastructure details, login artifacts, or exploit details in an
  issue or pull request.
- Keep changes focused. Explain user-visible behavior, compatibility impact,
  migration requirements, and rollback behavior.
- Do not change or couple the independently managed rescue window unless the
  issue and pull request explicitly scope that component.

## Development

Use Node.js 22 for parity with the supported server setup:

```bash
npm ci
npm test
npm run test:browser
```

Run `npm run precheck` and `git diff --check` before submitting. Browser tests
require the Playwright Chromium build and its operating-system dependencies.

Tests must not contain real email addresses, IP addresses, hostnames, ports,
tokens, account identifiers, or credentials. Use `example.test`,
`203.0.113.0/24`, `198.51.100.0/24`, or `192.0.2.0/24` fixtures.

## Pull requests

- Add or update tests for behavior changes.
- Update both English and Simplified Chinese user-facing text when applicable.
- Preserve account isolation and enforce permissions on the server, not only
  in the browser.
- Never weaken sandbox, approval, ownership, file-mode, UID/GID, path-boundary,
  SSRF, CSRF, WebSocket-origin, or command-argument validation for convenience.
- Do not commit generated archives, runtime state, screenshots with account
  data, dependency directories, or local configuration.

By submitting a contribution, you agree to license it under the MIT License,
the license of the WFL Codex Web Workspace code in this repository. Components that
retain a separate upstream license are documented in `NOTICE` and
`THIRD-PARTY-NOTICES.md`.
