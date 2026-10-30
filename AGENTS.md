# Repository guide

This is an original React + Express-on-Cloudflare Workers application. Read `README.md` and `THIRD_PARTY_NOTICES.md` before changing UI, Worker bindings, package assets or deployment.

## Non-negotiable architecture

- Only UTF-8 text `.tex` documents are supported. Store source in D1 `documents.source` (TEXT) and IndexedDB device drafts. No image/binary source uploads.
- pdfTeX compilation executes in a cancellable dedicated browser worker using only the pinned local package manifest. Never use HTML-print/MathJax as a substitute for real PDF generation; never enable shell escape or runtime CDN/package fetching.
- Backend code is Express 5 / JavaScript, Drizzle ORM and D1. Every document operation must remain owner-scoped; use schema-defined tables, parameterized Drizzle queries, explicit inputs/size limits and session security.
- Changes to `server/schema.js` require a reviewed additive/expand migration committed from `npm run db:generate`. Never reset/push production schema. Deploy first additive schema before dependent code; drop/contract only in a later release.
- Never stage `.env`, `.dev.vars`, local D1/`.wrangler`, auth credentials, build/test output or account tokens. `git check-ignore .env` must succeed. Never put secrets in `VITE_*`, assets, source archives or logs.
- Production migrations and Worker versions deploy only through the protected `master` CI/CD after PR merge. Never manually deploy or apply remote production migrations.
- Keep license notices, compiler source availability and per-asset SHA-256 manifest synchronized when updating vendored TeX assets.

## Multiple independent contributors

Create one branch/worktree per independently reviewed feature; never edit a shared `master` working tree for concurrent features. Example:

```powershell
git worktree add ..\KhanhhNeLatex-sessions -b feat/sessions
cd ..\KhanhhNeLatex-sessions
npm ci
npm run db:worktree
npm run dev:worktree
```

`npm run dev:worktree` picks an unused local port and isolated `.wrangler/worktree-state` database. Run `npm run db:worktree` in each worktree. Never bind local development to production D1 or a production API. `npm test`, `npm run db:check`, `npm run build`, and `npm run test:e2e` must pass before review.

## Required self-review before every PR/merge

Inspect the full diff, including migrations and generated compiler/static assets. Check ownership/CSRF/session/error edges; malicious, oversized or non-text input; IndexedDB data-loss/races; revision conflicts; keyboard/screen-reader/mobile UX; browser network requests; CPU/RAM on low-end devices; worker timeout, cancel and object-URL cleanup; cache/CSP/CORS; incremental bundle-size impact; source archive/notice/license completeness; and expand/contract compatibility with currently deployed code. Test actual compilation and PDF magic bytes when compiler paths change. Verify `.env` is ignored, the source archive is secret-free, asset hashes match, and there is no remote or manual deploy requirement in local scripts.

When clean, push the feature branch, open a PR, wait for the required `Quality / verify` check, address comments/failures, then `gh pr merge <number> --auto --squash`. Merge/rebase conflicts locally and rerun checks. No human approval is expected, but no agent can bypass a failing required check. Only a merged PR changes deployed code/database.
