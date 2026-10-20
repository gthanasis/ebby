// Each person's keys are sealed so a leaked database holds only ciphertext, bound to the person and the kind.
import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import * as vault from "../src/shared/vault.js";

const KEY = process.env.CREDENTIALS_KEY!;
afterEach(() => { process.env.CREDENTIALS_KEY = KEY; delete process.env.CREDENTIALS_OLD_KEYS; });

describe("vault", () => {
  it("opens what it sealed", () => {
    const s = vault.encrypt(Buffer.from("secret"), 1, "anthropic");
    expect(vault.decrypt(s, 1, "anthropic").toString()).toBe("secret");
  });

  it("opens what the Python app sealed", () => {
    const sealed = { keyId: "5e318f8c", nonce: Buffer.from("/+4Je/UYE4RO9pbW", "base64"),
      ciphertext: Buffer.from("M/fsHANJty3ZPfolKuCARl7FyamxYgjyOnLW93IpE3gjUn/ietYE/XH/z0pskxK8YCtT", "base64") };
    expect(JSON.parse(vault.decrypt(sealed, 7, "anthropic").toString())).toEqual({ api_key: "sk-ant-python-sealed" });
  });

  it.each([[2, "anthropic"], [1, "enable_banking"]])("refuses another person or kind (%s, %s)", (user, kind) => {
    const s = vault.encrypt(Buffer.from("secret"), 1, "anthropic");
    expect(() => vault.decrypt(s, user, kind)).toThrow();
  });

  it("refuses tampered ciphertext", () => {
    const s = vault.encrypt(Buffer.from("secret"), 1, "anthropic");
    s.ciphertext[0] ^= 1;
    expect(() => vault.decrypt(s, 1, "anthropic")).toThrow();
  });

  it("an old key still opens what it sealed, and is due for rotation", () => {
    const s = vault.encrypt(Buffer.from("secret"), 1, "anthropic");
    process.env.CREDENTIALS_OLD_KEYS = KEY;
    process.env.CREDENTIALS_KEY = Buffer.alloc(32, "n").toString("base64");
    expect(vault.decrypt(s, 1, "anthropic").toString()).toBe("secret");
    expect(vault.needsRotation(s)).toBe(true);
  });

  it("a key that was removed can't", () => {
    const s = vault.encrypt(Buffer.from("secret"), 1, "anthropic");
    process.env.CREDENTIALS_KEY = Buffer.alloc(32, "n").toString("base64");
    expect(() => vault.decrypt(s, 1, "anthropic")).toThrow(/No credentials key/);
  });

  it.each([["", "isn't set"], ["not base64!", "CREDENTIALS_KEY must be 32 bytes"], [Buffer.alloc(16).toString("base64"), "CREDENTIALS_KEY must be 32 bytes"]])("names a bad master key (%s)", (value, message) => {
    process.env.CREDENTIALS_KEY = value;
    expect(() => vault.encrypt(Buffer.from("x"), 1, "k")).toThrow(message);
  });

  it("takes an RSA private key and fingerprints its public half", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }));
    expect(vault.validatePem(pem)).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each([Buffer.from("hello"), Buffer.from(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }))])(
    "refuses anything else as a key", (data) => expect(() => vault.validatePem(data)).toThrow(vault.NOT_A_KEY));

  it("refuses an oversize file even if it's a key", () => {
    expect(() => vault.validatePem(Buffer.alloc(vault.MAX_PEM_BYTES + 1, "a"))).toThrow(vault.NOT_A_KEY);
  });

  it("reads application ids the way Python's uuid does", () => {
    expect(vault.validateAppId(" {12345678-1234-5678-1234-56789ABCDEF0} ")).toBe("12345678-1234-5678-1234-56789abcdef0");
    expect(vault.validateAppId("123456781234567812345678abcdef00")).toBe("12345678-1234-5678-1234-5678abcdef00");
    expect(() => vault.validateAppId("not-an-id")).toThrow(/application ID/);
  });

  it("masks an API key to its last four", () => expect(vault.maskApiKey(" sk-ant-abcdWXYZ ")).toBe("key ending …WXYZ"));
});
