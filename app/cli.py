"""Command line: `bank-sync <command>` (or `uv run bank-sync <command>`).

  serve                 run the dashboard and the background sync (port 8000)
  connect [BANK]        print a bank login link, then paste the address you land on
  sync                  fetch new transactions now
  import SESSION DIR    load a session.json and per-account JSON dumps from the old eb.py
  recategorize          re-run category rules over everything stored
  import-sqlite DB EMAIL [--admin]
                        move an old single-user spending.db into Postgres as EMAIL's data
  add-user EMAIL [--admin]
                        put EMAIL on the allow list
  demo-seed [EMAIL]     fill a made-up person's six months of spending (default demo@spending.local)

Commands that work on someone's data act as the admin.
"""

import json
import sys
from pathlib import Path

from . import config, db, sync


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    cmd = args[0]
    db.init()
    if cmd == "import-sqlite" and len(args) >= 3:
        from .import_sqlite import run
        for table, n in run(Path(args[1]), args[2], admin="--admin" in args).items():
            print(f"{table}: {n}")
        return
    if cmd == "add-user" and len(args) >= 2:
        from .import_sqlite import ensure_user
        print(f"{args[1]} is user {ensure_user(args[1], admin='--admin' in args)}")
        return
    if cmd == "demo-seed":
        from . import demo
        print(demo.seed(*args[1:2]))
        return
    if cmd == "serve":
        import uvicorn
        uvicorn.run("app.server:app", host="0.0.0.0", port=8000)
        return
    admin = db.admin_id()
    if admin is None:
        sys.exit("No admin yet: run `bank-sync add-user EMAIL --admin` first.")
    with db.as_user(admin):
        _run(cmd, args)


def _run(cmd, args):
    if cmd == "connect":
        bank = args[1] if len(args) > 1 else config.BANK
        print(f"\nOpen this link and approve access:\n\n  {sync.start_auth(bank)}\n")
        address = input("Paste the address you land on: ")
        bank, count = sync.complete_auth(address)
        print(f"Connected {count} {bank} account(s). Backfilling history now...")
        sync.sync()
    elif cmd == "sync":
        print("ok" if sync.sync() else "failed, see the dashboard or logs")
    elif cmd == "import" and len(args) == 3:
        import_legacy(Path(args[1]), Path(args[2]))
    elif cmd == "recategorize":
        with db.connect() as conn:
            db.recategorize(conn)
            print(f"{db.dedupe(conn)} debit-card duplicates paired")
    else:
        sys.exit(__doc__)


def _legacy_label(acc):
    ident = (acc.get("account_id") or {}).get("iban") or acc.get("uid", "")
    return f"{acc.get('name') or acc.get('product') or 'account'}-{ident[-4:]}"


def import_legacy(session_file: Path, folder: Path):
    session = json.loads(session_file.read_text())
    with db.connect() as conn:
        for acc in session.get("accounts", []):
            db.upsert_account(conn, acc, config.BANK)
            dump = folder / f"{_legacy_label(acc)}.json"
            rows = json.loads(dump.read_text()) if dump.exists() else []
            dates = sorted(r.get("booking_date") or r.get("transaction_date") or "" for r in rows)
            if rows:
                db.save_window(conn, acc["identification_hash"], acc.get("cash_account_type") != "CACC",
                               dates[0], dates[-1], rows)
            print(f"{acc.get('name')}: {len(rows)} rows")
        db.update_connection(conn, config.BANK, session_id=session["session_id"],
                             valid_until=(session.get("access") or {}).get("valid_until"), last_sync=sync.now_iso())
        db.set_meta(conn, "last_attempt", sync.now_iso())


if __name__ == "__main__":
    main()
