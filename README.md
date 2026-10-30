# KhanhhNeLatex

An original, deliberately small Prism-inspired LaTeX workspace. React JavaScript frontend, Express 5 API on Cloudflare Workers' native Node HTTP adapter, Drizzle ORM and Cloudflare D1. No Prism code/assets, AI, image uploads, server compilation, or polling.

## Local development

Requires Node 26.12+ (or a cf-supported Node version), npm, and a Chromium-compatible browser with WebAssembly, Workers and IndexedDB.

```powershell
npm ci
npm run db:local
npm run build
npm run preview
# http://127.0.0.1:8787 -- real Cloudflare Workers runtime + local D1
```

In another terminal, `npm run dev` optionally serves Vite HMR at port 5173 and proxies API requests to the local Worker. Local API mutations require the configured origin: use the main 8787 preview for sign-in/cloud-save testing. Compile assets are included locally, never fetched from an external service at runtime.

```powershell
npm test
npx playwright install chromium
npm run test:e2e
```

The browser tests include a real WASM PDF compile/export, worker cancellation/error handling, local persistence, text-only import validation, responsive layout, session cookies, ownership/CSRF checks and revision conflicts.

## Writing and persistence

- One text-only UTF-8 `.tex` file per document, maximum 100,000 characters; imports also limited to 400 KB. No image, font, binary or other source uploads.
- IndexedDB device drafts save after a 300 ms pause and flush on document switches/visibility changes. Pending/failed saves are explicit; pending writes warn before navigation. Export `.tex` for backups, especially before clearing browser data or changing devices. Device drafts are not encrypted; use a trusted personal device.
- Cloud saves are **explicit**, using the Save button or Ctrl+S. Typing/compiling never sends document source to the API. Sign-in is optional for local editing, compiling and exports.
- D1 stores source in a `TEXT` column. Every document operation is owner-scoped. Atomic revision checks reject stale cloud updates rather than overwriting them. Up to 100 cloud documents per account.
- Accounts use case-insensitive 3-32 character usernames and 12-128 character passwords. Salted scrypt (N=16384,r=8,p=1), hashed random 256-bit session tokens, seven-day HttpOnly/SameSite=Strict cookies (Secure on HTTPS), strict mutation origins, parameterized Drizzle queries, request limits and D1-backed auth throttling. No password reset/recovery is provided in this minimal version.

## Browser compilation and limits

Real SwiftLaTeX pdfTeX WASM, not HTML printing or math-only rendering. A lazy-loaded, dedicated classic Worker makes two compilation passes. One job at a time; Cancel terminates immediately; a 60-second timeout terminates stalled jobs. The Worker is terminated after success/failure, releasing its heap. PDF blob URLs are revoked on replacement/switching. Preview uses the browser's native PDF viewer; browsers without one can export the generated PDF.

The included subset covers the tested `article` (10/11 pt), `report` and `book` (10 pt) classes, `amsmath`, `amssymb`, `geometry` and the Computer Modern fonts exercised by the fixtures. This is **not a full TeX Live installation**. Arbitrary packages, fonts, Unicode scripts, shell escape, source assets, and uploaded bibliographies are unsupported. Missing packages return compiler logs. `scripts/bundle-tex.mjs` is an explicit maintainer asset-acquisition tool; the deployed application never downloads additional packages or contacts that mirror.

The initial app is about 77 KB JS gzip plus 4 KB CSS gzip. First compile fetches roughly 13 MB uncompressed runtime/format/package assets; the largest is the 10.36 MB format, below Cloudflare's 25 MiB per-file limit. Browser HTTP caching avoids repeat network transfer where supported, but a new bounded Worker is created per compile, trading some startup work for lower idle RAM. Active compiler memory can exceed 100 MB. Manual compilation avoids CPU churn. 120 fps/8.33 ms is a design target, not a guarantee on low-end devices. No artificial claim of zero CPU/RAM or universal package support.

Editing remains usable offline while the app is loaded; IndexedDB persists drafts. This version does not install a service worker, so a first visit/reload offline and uncached compiler assets require a connection.

## Database schema and Cloudflare deployment

`server/schema.js` is the authoritative Drizzle schema. `npm run db:generate` generates reviewed SQL and snapshots in `migrations`. `npm run db:check` checks the Drizzle journal and fails if schema changes need a new committed migration. Do not use schema push/reset in production. Migrations use forward-only expand/contract changes: deploy additive schema before code that depends on it; remove obsolete columns in a later PR once all deployed code no longer reads them.

Use the authenticated Cloudflare account with `cf auth whoami`. The checked-in `.github/workflows/quality.yml` runs tests on each PR and deploys only after a PR merges into `master`: it applies D1 migrations **before** code deployment and serializes production updates. Do not run manual production deploys or remote migrations. GitHub Actions needs the narrowly scoped repository Actions secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit and D1 Edit, account scope). Configured URL after a successful first deployment: `https://khanhhne-latex.khanhhne.workers.dev`. AI is deferred; the application does not send the local `.env` key or require a production AI secret.

## Separate, isolated worktrees

```powershell
git worktree add ..\KhanhhNeLatex-auth -b feat/auth
cd ..\KhanhhNeLatex-auth
npm ci
npm run db:local
npm run dev:worktree
```

`dev:worktree` selects an available localhost port, creates a per-worktree `.wrangler/worktree-state` local D1 store, and writes an ignored per-worktree `.dev.vars` for same-origin requests. Run `npm run db:worktree` in each worktree to initialize its isolated database. No remote database or production credentials are used by local development. Use a single `dev:worktree <port>` argument to choose a port.

## Tests and collaboration

Every pull request to `master` runs `Quality / verify`: npm install, browser setup, unit and end-to-end tests, migration consistency, and production build. Merge a ready change with `gh pr merge <number> --auto --squash` after the check passes. Resolve conflicts/rebase against current `master`, rerun checks, and update the PR. No human approval is required by the repository ruleset, but status checks cannot be bypassed.

Before handing off/merging a change, review the complete diff; check missing/error paths, authorization, input sizes and text-only handling; prove actual browser-worker PDF compilation and export where relevant; test mobile and keyboard behavior; inspect network requests to ensure editing is offline/local; verify browser worker/object URL release and bounded job lifetime; test D1 ownership and stale revisions; review new SQL for expand/contract compatibility; and confirm `git status --ignored`, `git check-ignore .env`, build asset contents, and secret-scan results. A passing build alone is not functional or security evidence.

## Secrets and licensing

Root `.env` is Git-ignored, plaintext, server-only and restricted to the current Windows user where available. `.env.example` contains placeholders only. Never prefix credentials with `VITE_`, put them in `public`, return/log them, or deploy `.env`. Wrangler dev loads `.env` as a server binding; production deploy workflows do not read or upload it. AI is deferred and the key is never used. Rotate/revoke any key previously shared in chat. For future AI production setup, use a Worker secret (`wrangler secret put OPENAI_API_KEY` after authenticating the appropriate CLI), not an uploaded env file.

GNU AGPL v3 only; see `LICENSE` and `THIRD_PARTY_NOTICES.md`. Each build generates an allowlisted, secret-free `/source.tar.gz` so deployed users can obtain corresponding application source. The compiler source archive and notices are linked in Help. TeX files/fonts retain their upstream licenses.
