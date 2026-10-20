# Working on ebby

ebby puts every bank you use in one place: it reads accounts through Enable Banking, sorts spending into
categories, and plans the month around payday. One FastAPI app (`app/`) serves the API and a React PWA
(`web/`), backed by Postgres. Several people share one install; each sees only their own data.

## Run it

```bash
docker run -d --name bank-sync-pg -e POSTGRES_USER=bank_sync_owner -e POSTGRES_PASSWORD=owner \
  -e POSTGRES_DB=bank_sync -p 55432:5432 postgres:17-alpine   # once
uv sync && uv run pytest -q                                    # tests: a real Postgres, a fresh database per run
cd web && npm ci && npm run build                              # typecheck + build
cd web && npm run dev:mock                                     # the UI on :5176 with a fake API (web/mock-api.ts)
```

`DEMO=1` in `.env` and `bank-sync demo-seed` give the real backend six months of made-up spending.

## Rules the code depends on

- **Every person's data is fenced by Postgres row-level security.** A new table that holds someone's data gets
  `user_id bigint NOT NULL DEFAULT app_user() REFERENCES users(id) ON DELETE CASCADE`, and its migration
  enables and forces row-level security and creates the `own_rows` policy on it, as the loop at the end of
  `app/migrations/001_schema.sql` does for the first tables. Code reads and writes through `db.connect()` inside
  `db.as_user(...)`; never filter by user by hand. `tests/test_isolation.py` must keep passing.
- **ebby runs as several pods at once.** Nothing that must be the same everywhere may live in a pod's memory.
  "Only one at a time" is a Postgres advisory lock (`db.advisory_lock`), and a cache is fine only if a stale
  value for a minute is. Files on disk aren't shared either: settings and keys come from the environment or
  the database.
- **Migrations are new numbered files** in `app/migrations/` (`002_….sql`), applied at startup. Never edit
  one that's merged. During a deploy the previous version keeps running against the new schema, so a
  migration only adds: new tables, new nullable or defaulted columns, new indexes. Taking anything away or
  changing it is a breaking change (below).
- **Categories:** rules live in `app/categories.py`. After changing them, bump `categories.VERSION` so stored
  history is sorted again. A new category also goes in the web sorter's order (`web/src/components/Sorter.tsx`),
  and its icon in the registry (`web/src/components/ui.tsx`), or it renders as "•••".
- **Banks are rate-limited:** about four unattended fetches a day per connection. Don't add calls to Enable
  Banking in a loop or on page load beyond what `sync.py` already does.
- **UI:** use the app's own tokens and components (`web/src/styles.css`, `web/src/components/ui.tsx`); check it
  in both light and dark, at phone width. When a screen gains an API route, add it to `web/mock-api.ts`.

## Code and commits

- Match the surrounding code: plain names, comments that say why, not what.
- A commit title says what changes for the person using ebby ("Sorting a payment ends on one Save & next
  button"), the body says why. No `feat:`/`fix:` prefixes. One concern per commit.
- Add a test for every fix that would have caught it, and run the whole suite before opening a pull request.

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
