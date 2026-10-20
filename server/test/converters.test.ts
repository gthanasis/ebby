// Converters decide what leaves the server, so what they leave out matters as much as what they keep.
import { describe, expect, it } from "vitest";

import { toCredentials } from "../src/modules/banks/converters.js";

describe("credentials as the app sees them", () => {
  it("show only the known public fields of each key", () => {
    const rows = [
      { kind: "enable_banking", public_info: { app_id: "app-1", key_fingerprint: "ab:cd", pem: "-----BEGIN PRIVATE KEY-----" }, verified_at: "2026-10-20T06:00:00+00:00" },
      { kind: "anthropic", public_info: { masked: "key ending …abcd", api_key: "sk-ant-secret" }, verified_at: null },
      { kind: "something_new", public_info: { token: "x" }, verified_at: null },
    ];
    expect(toCredentials(rows)).toEqual({
      enable_banking: { app_id: "app-1", key_fingerprint: "ab:cd", verified_at: "2026-10-20T06:00:00+00:00" },
      anthropic: { masked: "key ending …abcd", verified_at: null },
    });
  });
});
