# Working on ebby

ebby puts every bank you use in one place: it reads accounts through Enable Banking, sorts spending into
categories, and plans the month around payday. One TypeScript server (`server/`: Hono, Kysely, Zod) serves the
API and a React PWA (`web/`), backed by Postgres. Several people share one install; each sees only their own data.

## Run it

```bash
docker run -d --name bank-sync-pg -e POSTGRES_USER=bank_sync_owner -e POSTGRES_PASSWORD=owner \
  -e POSTGRES_DB=bank_sync -p 55432:5432 postgres:17-alpine   # once
cd server && npm ci && npm run typecheck && npm test           # types, then tests on a real Postgres (CI runs both)
cd server && npm run dev                                       # the server on :8000, reloading on change (reads ../.env)
cd web && npm ci && npm run build                              # the web app: typecheck + build
cd web && npm run dev:mock                                     # the UI on :5176 with a fake API (web/mock-api.ts)
```

`DEMO=1` in `.env` and `npx tsx src/main.ts demo-seed` (in `server/`) give the server six months of made-up
spending. In the image the commands are `ebby serve`, `ebby demo-seed`, `ebby add-user EMAIL --admin`.

## Where things are

```
server/
  src/main.ts         commands: serve, demo-seed, add-user
  src/server.ts       builds the app: the sign-in middleware, every feature's routes, the web app's files
  src/scheduler.ts    the background round per person: sync, alerts, the weekly read
  src/config.ts       the only place that reads the environment: validated settings, and secrets apart
  src/modules/        one folder per feature; inside, routes.ts (HTTP), service.ts (the logic), repo.ts (SQL):
    account/          you, sign-in (auth), people, settings
    banks/            connecting banks, sync, Enable Banking, the bank list, keys (credentials), ingest
                      (bank rows → stored rows, categorizing, pairing debit-card copies)
    transactions/     the overview and the transaction list, moving a payment
    spending/         spending by range, services (payees grouped), subscriptions, cash, open questions
    plan/             the plan and budgets, pace, today, the year, a category's detail, payday, savings
                      accounts, extra pay
    commitments/  goals/  habits/ (habit rules, wishlist, yearly costs)
    alerts/           cool-down and commitment alerts, web push
    assistant/        the chat, the sorter's guesses, the weekly read and explanations (ai), the AI allowance,
                      prompts/
    demo/             the made-up demo person
  src/shared/         what every feature uses: db (connections, whose data, meta), months (the pay calendar),
                      categories, spend_sql (what counts as spending), constants, clock (the only place that reads
                      the time), http (errors, body checks), vault, reference/ (merchant codes),
                      ledger/ (the transactions, rules and accounts tables: read by nearly every feature),
                      utils/python.ts (Python's rounding, json.dumps and dates, exactly: see "Numbers" below)
  src/types/          db.ts: the tables, generated from migrations/ (npm run db:types after adding one; CI checks);
                      entities.ts: rows as the app reads them, and the JSON documents kept in meta
  migrations/         numbered SQL files, applied at startup
  test/               unit tests, and test/api/: the API as a black box (below)
```

`docs/index.html` is the public documentation (docs-ebby.gthanasis.com): one hand-written page in the app's own
tokens and components, with the screenshots beside it. Merging a change under `docs/` publishes it
(`.github/workflows/docs.yml`). When a feature changes what a person sees or does, update its page there.

Code is organized by feature. A new endpoint goes in its feature's routes.ts, its logic in service.ts (or a file
named for the idea), its queries in repo.ts. `npm run check:structure` (a CI step) keeps it that way:
- shared/ never imports a feature; only server.ts imports a routes.ts;
- repositories import only shared/; SQL lives only in repositories, shared/db.ts and shared/ledger/;
- features may use each other but never in a circle (routes aside, which only wire); no file cycles, no dynamic
  `import()`. Something two features both need goes in the lower one, or in shared/.

**Responses have schemas.** A feature's `schemas.ts` declares, in Zod, what each of its routes returns (`responses`,
keyed `"GET /api/goals"`) and names the shapes (`schemas`); `src/contract.ts` gathers them. The read tests hold every
snapshot to its route's schema (strict: an extra key fails), and `npm run api:types` turns them into
`web/src/lib/api.gen.ts`, which the web app imports instead of writing API types by hand (CI checks it's current).
`converters.ts` turns rows into those shapes: pure functions, no database, easy to test. A new or changed response
means: schema, converter, `npm run api:types`.

Routes stay thin: they check input and call the service. Queries use Kysely's typed builder for single-table
reads and writes and SQL with `?` placeholders (`conn.execute`) for the rest; callers open the transaction
(`db.connect(conn => ...)`).

## Tests

- **`server/test/api/` is the contract.** A fresh database holds only the demo person, the clock is pinned to
  `EBBY_NOW`, and every read endpoint is compared with a snapshot in `test/api/snapshots/`, number for number
  (first taken from the Python app the server was ported from); `writes.test.ts` drives the writes and checks
  them through the reads. A new GET route fails until it has a snapshot. When a change is meant to alter what a
  read returns, retake them with `UPDATE_SNAPSHOTS=1 npm test` and check the diff is exactly that change.
- **Unit tests** cover what's easy to get wrong without noticing: isolation between people, sign-in, encryption,
  pay-month edges, the bank fetching history. Add one with every fix.
- Anything that reads the time uses `clock` (`clock.now()`, `clock.today()`), never `new Date()` or
  `Date.now()` for a date that matters, so tests can pin it. Anything a response lists comes out in a fixed order:
  break ties.

## Rules the code depends on

- **Every person's data is fenced by Postgres row-level security.** A new table that holds someone's data gets
  `user_id bigint NOT NULL DEFAULT app_user() REFERENCES users(id) ON DELETE CASCADE`, and its migration
  enables and forces row-level security and creates the `own_rows` policy on it, as the loop at the end of
  `server/migrations/001_schema.sql` does for the first tables. Code reads and writes through `db.connect()` inside
  `db.asUser(...)`; never filter by user by hand. `test/access.test.ts` must keep passing.
- **ebby runs as several pods at once.** Nothing that must be the same everywhere may live in a pod's memory.
  "Only one at a time" is a Postgres advisory lock (`db.advisoryLock`), and a cache is fine only if a stale
  value for a minute is. Files on disk aren't shared either: settings and keys come from the environment or
  the database.
- **Migrations are new numbered files** in `server/migrations/` (`002_….sql`), applied at startup. Never edit
  one that's merged. During a deploy the previous version keeps running against the new schema, so a
  migration only adds: new tables, new nullable or defaulted columns, new indexes. Taking anything away or
  changing it is a breaking change (below).
- **Settings come only from `server/src/config.ts`**, the one module that reads `process.env`: `config` for what
  tunes the app, `secrets` for what must never be logged. A new variable gets a rule there (and a line in
  `.env.example`); the server checks them all at startup and refuses to start, naming each problem.
- **Types come from the schema.** Read rows as the types in `src/types/entities.ts` (`conn.execute<Goal>(…)`), and
  meta documents through `db.getMeta(conn, "plan")`, which is typed by key: a new meta key gets its shape in
  `MetaDocuments`. Avoid adding `Row` (`Record<string, any>`).
- **Pay months need the pay calendar:** every request (the middleware) and every job's work for a person runs
  inside `withPayCalendar()` (shared/months.ts), which reads their payday fresh; `monthBounds` outside it throws
  rather than silently using the 1st. `PayCalendar` itself is plain: `new PayCalendar(25).monthBounds("2026-10")`.
- **Numbers and ids match what Python wrote.** Stored data and transaction ids were first made by a Python app,
  and the snapshots hold its numbers. Round money with `pyRound` (halves to even), format with `fmt0`/`fmt2`,
  and build stored JSON and ids with `pyDumps`. A plain `Math.round` or `JSON.stringify` there changes totals
  or makes a sync store a payment twice.
- **Categories:** rules live in `server/src/shared/categories.ts`. After changing them, bump `VERSION` so stored
  history is sorted again. A new category also goes in the web sorter's order (`web/src/components/Sorter.tsx`),
  and its icon in the registry (`web/src/components/ui.tsx`), or it renders as "•••".
- **Banks are rate-limited:** about four unattended fetches a day per connection. Don't add calls to Enable
  Banking in a loop or on page load beyond what `jobs/sync.ts` already does.
- **UI:** use the app's own tokens and components (`web/src/styles.css`, `web/src/components/ui.tsx`); check it
  in both light and dark, at phone width. When a screen gains an API route, add it to `web/mock-api.ts`.

## Code and commits

- Match the surrounding code: plain names, comments that say why, not what.
- A commit title says what changes for the person using ebby ("Sorting a payment ends on one Save & next
  button"), the body says why. No `feat:`/`fix:` prefixes. One concern per commit.
- Add a test for every fix that would have caught it, and run lint and the whole suite before opening a
  pull request.

## Releases

Every merge to `main` is released on its own once CI passes on it (`.github/workflows/release.yml`): it's tagged
with the next version, published as a GitHub release, and built as `ghcr.io/gthanasis/ebby:<version>`. The pull
request's label picks the version, so **every pull request gets exactly one of these labels**:

| Label | When | 0.1.4 becomes |
|---|---|---|
| `release:patch` | fixes, copy, small tweaks | 0.1.5 |
| `release:minor` | new features, categories, settings with a default, additive migrations | 0.2.0 |
| `release:major` | anything an existing install has to act on, or that the previous version can't run beside | 1.0.0 |
| `release:none` | nothing a running install would notice: docs, tests, CI | no release |

**Breaking means:** a migration that drops, renames, changes the type of, or rewrites existing data; a setting
(environment variable) that's removed, renamed, newly required, or means something else; a change to how stored
data or keys are encoded (`vault.py`, `meta` values) that the previous version can't read; a new minimum for
Postgres or another dependency an install provides. Additions with defaults are never breaking.

**If a change is breaking, stop and ask the maintainer before going on.** Say what breaks and for whom, and
offer a non-breaking way if there is one, for example adding a new column now and removing the old one in a
later release. Only label `release:major` once they agree, and give the pull request an `## Upgrade notes`
section saying exactly what someone running ebby has to do; it becomes the top of the release notes.

`scripts/release.py check` runs on every pull request and fails when the label is missing, or when the diff
looks breaking (destructive SQL in a new migration, an edited migration, a setting gone from `.env.example`)
under a smaller label. If it's a false alarm, explain it on a line of its own in the description:
`Not breaking: <why>`.

The git tag is the version; nothing in the code carries it (`pyproject.toml`'s `version` isn't used).

Installs follow the major version's image tag (`ghcr.io/gthanasis/ebby:0` in `compose.yaml`), so a major
release reaches nobody until they move to it. Deploying a release to an install is done there, not here.
