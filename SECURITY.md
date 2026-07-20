# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities. Instead, use GitHub's private reporting:

**[Report a vulnerability](https://github.com/MarioundMB/Hearth/security/advisories/new)** (Security tab → "Report a vulnerability")

Include steps to reproduce, affected version, and impact if known. We'll acknowledge reports as soon as possible and keep you updated as the issue is investigated and fixed.

## Supported Versions

Hearth ships continuous rolling releases from `main` via the built-in self-updater. Only the latest version is supported — please update before reporting an issue to confirm it still reproduces.

## Scope notes

Hearth requires Docker socket access to manage containers, which is root-equivalent on the host by design — this is documented in the [README](README.md#-security-notes) and is not itself a vulnerability. Reports about privilege boundaries *within* Hearth (e.g. auth bypass, path traversal in the file manager, proxy/firewall rule injection) are very welcome.
