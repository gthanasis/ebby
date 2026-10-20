// Set before any app module reads them. TEST_DATABASE_OWNER_URL points at the Postgres the tests may create
// databases on (default: the local container from .env.example).
const owner = new URL(process.env.TEST_DATABASE_OWNER_URL ?? "postgresql://bank_sync_owner:owner@localhost:55432/postgres");
const app = new URL(owner.href);
app.username = "bank_sync_test_app"; app.password = "test";
owner.pathname = app.pathname = "/ebby_ts_test";
Object.assign(process.env, {
  DATABASE_OWNER_URL: owner.href, DATABASE_URL: app.href, TEST_ADMIN_URL: process.env.TEST_DATABASE_OWNER_URL ?? "postgresql://bank_sync_owner:owner@localhost:55432/postgres",
  GOOGLE_CLIENT_ID: "", APP_PASSWORD: "", ADMIN_EMAIL: "", SESSION_SECRET: "test-secret", DEMO: "", EBBY_SCHEDULER: "off",
  PUBLIC_URL: "http://localhost:8000", TZ_NAME: "Europe/Athens",
  CREDENTIALS_KEY: Buffer.alloc(32, "k").toString("base64"),
});
