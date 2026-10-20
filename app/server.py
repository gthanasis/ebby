import base64
import mimetypes
import logging
import secrets

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles


from app import config
from app.api import auth
from app.data import db, users
from app.jobs import sync

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = FastAPI(title="bank-sync")
mimetypes.add_type("application/manifest+json", ".webmanifest")


@app.on_event("startup")
def startup():
    db.init()
    if config.ADMIN_EMAIL and db.admin_id() is None:
        from app.data.import_sqlite import ensure_user
        ensure_user(config.ADMIN_EMAIL, admin=True)
    sync.run_scheduler()


PUBLIC_PATHS = {"/api/healthz"}
_store = users.Store()
app.include_router(auth.router(_store))


def _private(path: str) -> bool:
    """Data lives behind /api and the bank's redirect. The app shell and its assets carry none,
    so they load signed out and show the login page."""
    return (path.startswith("/api/") and path not in PUBLIC_PATHS) or path == "/eb-callback"


@app.middleware("http")
async def authenticate(request: Request, call_next):
    if request.url.path in PUBLIC_PATHS or not _private(request.url.path):
        return await call_next(request)

    if config.GOOGLE_CLIENT_ID:
        user = await run_in_threadpool(auth.current_user, request, _store)
        if not user:
            return JSONResponse({"detail": "Sign in first."}, status_code=401)
        if not auth.origin_ok(request):
            return JSONResponse({"detail": "That request didn't come from this app."}, status_code=403)
        user_id = user["id"]
    elif config.APP_PASSWORD:
        header = request.headers.get("authorization", "")
        ok = False
        if header.startswith("Basic "):
            try:
                _, _, password = base64.b64decode(header[6:]).decode().partition(":")
                ok = secrets.compare_digest(password, config.APP_PASSWORD)
            except ValueError:
                ok = False
        if not ok:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="ebby"'})
        user_id = await run_in_threadpool(db.admin_id)
    elif config.LOCAL:
        user_id = await run_in_threadpool(db.admin_id)  # local runs without any login act as the admin
    else:
        # Public and no sign-in configured: acting as the admin would hand anyone their money.
        return Response("No sign-in configured: set GOOGLE_CLIENT_ID (or APP_PASSWORD for a private install).", status_code=503)
    if user_id is None:
        return Response("No users yet: set ADMIN_EMAIL or run `bank-sync add-user EMAIL --admin`.", status_code=503)
    # Everything downstream (endpoints, their threads, streams) reads and writes as this user.
    with db.as_user(user_id):
        return await call_next(request)


@app.get("/api/healthz")
def healthz():
    return {"ok": True}


from app.api import account, assistant, banks, commitments, goals, habits, plan, push, spending, transactions  # noqa: E402

for module in (account, transactions, banks, spending, commitments, assistant, habits, plan, goals, push):
    app.include_router(module.router)


if config.WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=config.WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        file = config.WEB_DIST / path
        if path and file.is_file() and config.WEB_DIST in file.resolve().parents:
            # The service worker and manifest must be re-checked on every load to pick up new builds.
            fresh = path in {"sw.js", "manifest.webmanifest"}
            return FileResponse(file, headers={"Cache-Control": "no-cache"} if fresh else None)
        return FileResponse(config.WEB_DIST / "index.html", headers={"Cache-Control": "no-cache"})
