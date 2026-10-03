# CI / CD

Two workflows. `ci.yml` runs on every push and PR; `deploy.yml` runs only after
CI goes green on `master`, or on a manual confirm.

## CI

| Job | What it does | Blocking |
|---|---|---|
| **guard** | self-checks both scanners, then scans every file that executes on install or build **and** every tracked file for committed credentials — before anything installs or builds | yes — `backend`, `frontend` and `e2e` all `needs: guard` |
| **backend** | `npm run test:unit` (selfchecks, no DB) → `npm run test:ci` (all integration tests against a real Mongo, with coverage and a JUnit file) → **coverage floor** → boots the server and runs `npm run test:smoke` | yes |
| **frontend** | `npm run lint` (advisory) → `npm test` (Vitest, blocking) → `npm run build` → uploads `dist` | tests and build yes, lint advisory |
| **e2e** | builds the frontend against a real backend, seeds a database, and drives Chromium (Playwright) through every admin, seller, rider and customer screen | yes |
| **audit** | `npm audit --audit-level=high` on both apps | no (`continue-on-error`) |

`audit` is the one job that does not wait for `guard`: `npm audit` reads the
lockfile and runs no project code, so there is nothing for a tampered config to
execute there.

### Why there is a build-config guard

`origin/master` has twice been force-pushed with obfuscated malware appended to
`Frontend/vite.config.js` — 2026-08-26 and again 2026-09-09. Vite loads that
file, so the payload ran on every `npm run dev` and on every CI runner that
built the frontend, with that job's secrets in reach.

`.github/scripts/scan-build-config.mjs` checks `*.config.*` files and
`package.json` install hooks against three independent rules:

1. **Known indicators** — strings from the two incidents. Exact and free, but
   worth little alone: one edited byte defeats it.
2. **Absurdly long lines** — over 500 characters. Appended payloads are
   minified onto one line; the 2026-09-09 one was 7,596 characters, padded with
   tabs so it sat off the right edge of an editor. Hand-written config is narrow.
3. **Constructs that do not belong in a config file** — `eval`, `new Function`,
   `child_process`, raw `node:http`/`node:net` clients, `atob`. A config
   declares options; it does not spawn processes or open sockets.

Rules 2 and 3 both fire on the real payload with every known indicator removed,
which is the point — the guard has to survive the attacker reading it.

Rule 3 is the one that can misfire; a config that shells out to `git` for a
build stamp is legitimate. `ALLOW` in the script exists for that, keyed
`path::rule`. It is empty today, and an entry belongs in review, not in a rush.

The scanner self-checks first (`--selftest`, seven cases). A detector that has
silently stopped detecting is worse than none, because it reads as a green tick.

`deploy.yml` runs the scan again after checkout. A `workflow_dispatch` deploy
skips CI entirely, and hand-deploying a tampered commit is exactly the route
someone would take once CI began refusing it.

### What the tests cover

| Layer | Where | What it proves |
|---|---|---|
| Backend integration | `Backend/tests/*.test.js` (~560 tests) | services against a real database: dispatch and batching, the whole rider lifecycle (accept → pickup → OTP → complete), pricing, stock, coupons, zones, seller profile, Directions fallbacks |
| Frontend unit | `Frontend/tests/*` (Vitest) | logic that used to live inside components: the seller redirect (rendered, not just the regex), the onboarding checklist, coupon rules, distance labels |
| End-to-end | `e2e/tests/*.spec.js` (~106 checks) | every admin and seller screen loads with no console error and no failed API call; login for all four apps; the regressions that were found by hand (blank page after creating a coupon, "Getting Started" at 0%, zone delete, the Zomato copy) |

The e2e pages are checked the way a person would: open it, wait for it to settle,
fail on any uncaught exception, console error, or `/api/v1` call that answers
4xx/5xx. Known noise is listed in `e2e/helpers.js` with the reason beside it.

### The coverage floor

`.github/scripts/check-coverage.mjs` reads the table that
`node --test --experimental-test-coverage` prints and fails when total line
coverage is under `COVERAGE_MIN_LINES` (set in `ci.yml`, currently **50%**, with
the real figure at ~55%). It is a ratchet, not a target: raise the floor when
coverage climbs and new code cannot quietly arrive untested. The figure lands in
the job summary on every run.

### The credential scan

Backend/seed_users.js carried a MongoDB Atlas connection string, password
included, from the first commit. `.github/scripts/scan-secrets.mjs` reads tracked
files and fails on database URIs with a real password, private keys, live
Razorpay keys, GitHub/AWS/Slack/Stripe tokens and Google API keys. It never
prints the value. Like the build-config guard it self-checks first and has no
dependencies.

It cannot undo a leak that is already in the history: **rotate the credential**.
The one allow-list entry (the Firebase *web* config key shown as a form default)
is public by design and carries its reason in the script.

### Why the integration tests use a real database

They cover the conditional decrement, the partial rollback and the restock
claim — all of which are Mongo behaviour. A mock would only assert that the mock
behaves like the mock, which is exactly the bug class these tests exist to catch.
The job runs `mongo:7` and `redis:7` as service containers.

The test helper refuses to run against a database whose name does not contain
`test`, because it truncates collections between cases.

### Why lint is advisory

`npm run lint` was in `package.json` but there was no eslint config, so it had
never run. Switching it on surfaced a backlog already in the tree:

| Rule | Count | Notes |
|---|---|---|
| `react-hooks/rules-of-hooks` | 89 (3 files) | conditional hook calls — genuinely breaks React |
| `no-case-declarations` | 20 (2 files) | `let`/`const` in a `switch` case without a block |
| `no-useless-escape` | 18 (7 files) | |
| `no-undef` | 15 (13 files) | undefined identifiers — a `ReferenceError` when reached |
| `no-unreachable` | 7 (2 files) | dead code after `return` |
| `no-dupe-keys` | 6 (1 file) | duplicate keys in `services/api/index.js`; the later one silently wins |
| other | 6 | |

Failing CI on these would block every unrelated change behind a cleanup nobody
has scheduled, so the historical count is reported rather than enforced. Errors
in files a PR actually touches **are** blocking — see the "Lint changed files"
step. When the backlog reaches zero, drop `continue-on-error` from the advisory
step and it can never come back.

The ~1955 warnings are almost all `eslint-plugin-react-hooks` v7's new rules
(`set-state-in-effect`, `immutability`, `purity`, …). They describe real smells
but are new opinions applied retroactively; promote one to `error` in
`Frontend/eslint.config.js` as its count reaches zero.

## Deploy

Calls the deploy webhook in `Backend/src/routes/deploy.routes.js`, signing an
HMAC over the exact request bytes the way that route verifies it.

**An unconfigured target is a skip, not a failure.** If the two secrets below are
missing, an automatic run (after CI on `master`) writes "Deploy skipped" to the
summary with a warning annotation and stops, so a repository without a deploy
target does not go red on every push. A *manual* run (`workflow_dispatch`) still
fails, because someone asked for a deploy and did not get one.

Required on the `production` environment:

| Secret | Purpose |
|---|---|
| `DEPLOY_WEBHOOK_URL` | e.g. `https://6amfresh.in/api/deploy` |
| `DEPLOY_WEBHOOK_SECRET` | must match the server's `DEPLOY_WEBHOOK_SECRET` |
| `DEPLOY_HEALTH_URL` | optional; polled after deploy, e.g. `https://6amfresh.in/health` |

The server also needs these in its `.env`, or the endpoint is not mounted at all
and returns 404:

```
DEPLOY_WEBHOOK_ENABLED=true
DEPLOY_WEBHOOK_SECRET=<32+ chars, same as the GitHub secret>
DEPLOY_SCRIPT_PATH=/root/6AM-Fresh/deploy/sync-server.sh
```

Response handling is explicit: `202` accepted, `409` a deploy was already
running (warning, not a failure), `403` signature mismatch, `404` endpoint not
mounted. The webhook returns immediately and runs the script in the background,
so the workflow then polls `/health` until the app serves again — "accepted" is
not "finished".

### The server-side script

`deploy/sync-server.sh` is what `DEPLOY_SCRIPT_PATH` should point at. It fetches,
resets the checkout to `origin/master`, **runs the build-config guard before it
installs or builds anything** (building executes `vite.config.js`), then
`npm ci`, builds the frontend and reloads pm2. It refuses to reset over real
commits that exist only on the server; `SALVAGE_LOCAL_COMMITS=1` saves them as
patches first (leaving `vite.config.js` out of the patches) and carries on.
Backups of the `.env` files go to `BACKUP_DIR` (default `/root/server-backup`).

`concurrency` allows one deploy at a time and never cancels one midway: the
script on the far side is not resumable.

## Running the same checks locally

From the repository root — worth running after any `git pull` that touches a
config file, since the payload is designed to be invisible in a diff view:

```bash
node .github/scripts/scan-build-config.mjs
node .github/scripts/scan-build-config.mjs --selftest
```

```bash
node .github/scripts/scan-secrets.mjs
node .github/scripts/scan-secrets.mjs --selftest
```

```bash
cd Backend
npm run test:unit          # no database needed
npm run test:integration   # needs Mongo; writes to a *_test database
npm run test:coverage      # same, with the coverage table
npm test                   # unit + integration
npm start & npm run test:smoke
```

```bash
cd Frontend
npm test                   # Vitest
npm run test:coverage
npm run lint
npm run build
```

The browser tests need a backend and a frontend running against a throw-away
database (its name must contain `e2e` or `test`, or the seeder refuses):

```bash
# backend, on its own port and database
cd Backend
MONGO_URI=mongodb://127.0.0.1:27017/switcheats_e2e node scripts/e2e-seed.mjs
PORT=5100 MONGO_URI=mongodb://127.0.0.1:27017/switcheats_e2e   USE_DEFAULT_OTP=true OTP_RATE_LIMIT=1000 REDIS_ENABLED=false node server.js

# frontend build pointed at it
cd Frontend && VITE_API_BASE_URL=http://127.0.0.1:5100/api/v1 npm run build && npx vite preview --port 4173

# the tests
cd e2e && npm ci && npx playwright install chromium
E2E_BASE_URL=http://127.0.0.1:4173 E2E_API_URL=http://127.0.0.1:5100/api/v1 npx playwright test
```

`OTP_RATE_LIMIT=1000` matters: every spec signs in with OTP `1234`, and the
default (3 per phone per 10 minutes) locks you out after a couple of runs.
