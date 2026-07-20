# Contributing to Hearth

Thanks for taking the time to contribute! Bug reports, feature requests, and pull requests are all welcome.

## Reporting a bug

Please check [existing issues](https://github.com/MarioundMB/Hearth/issues) first, then open a new one with:

- Hearth version (bottom of the admin panel, or `package.json`)
- Docker / Docker Compose version, host OS
- Steps to reproduce, and what you expected to happen
- Relevant logs (Settings → Update / container logs)

For security vulnerabilities, please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Suggesting a feature

Open an issue describing the problem you're trying to solve, not just the solution — it makes it easier to discuss alternatives. Check [existing issues](https://github.com/MarioundMB/Hearth/issues) and [CHANGELOG.md](CHANGELOG.md) first to see if something similar is already planned or was recently addressed.

## Local development

Hearth has no build step — you edit `server.js` / `public/**` and reload.

```bash
git clone https://github.com/MarioundMB/Hearth.git
cd Hearth
cp .env.example .env
docker compose -f docker-compose.local.yml up -d --build
```

This starts Hearth on `http://localhost:4500` (admin), `:3000` (guest view) and `:8080` (reverse proxy), plus disposable firewall/VPN helper containers for testing those tabs without touching your host.

## Code style

- **Backend:** plain Node.js/Express in `server.js` — no ORM, no framework beyond what's already a dependency
- **Frontend:** vanilla HTML/CSS/JS in `public/` — no build tooling, no frontend framework. Match the existing structure in `public/js/admin.js`, `guest.js`, `common.js`
- Keep new strings translatable via `public/js/i18n.js` if they're user-facing
- No linter is enforced — just match the formatting of the surrounding code

## Pull requests

- Branch off `main`, keep PRs focused on one change
- Describe *what* changed and *why* in the PR description
- UI changes: a before/after screenshot or short clip is very helpful for review
- Maintainers handle version bumps in `package.json` / `CHANGELOG.md` — you don't need to do this in your PR
