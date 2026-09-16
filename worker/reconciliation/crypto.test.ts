import { describe, expect, it } from "vitest";

import { decryptConfiguration, encryptConfiguration } from "./crypto.ts";

const key = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)),
);
const otherKey = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)),
);

describe("configuration encryption", () => {
  it("round-trips a versioned AES-256-GCM envelope without plaintext", async () => {
    const secret = { token: "do-not-display", email: "operator@example.com" };
    const envelope = await encryptConfiguration(secret, key, () =>
      new Uint8Array(12).fill(7),
    );

    expect(envelope).toEqual({
      version: 1,
      iv: "BwcHBwcHBwcHBwcH",
      ciphertext: expect.any(String),
    });
    expect(JSON.stringify(envelope)).not.toContain(secret.token);
    await expect(decryptConfiguration(envelope, key)).resolves.toEqual(secret);
  });

  it("fails closed for the wrong key and malformed key material", async () => {
    const envelope = await encryptConfiguration({ token: "secret" }, key);
    await expect(
      decryptConfiguration(envelope, otherKey),
    ).rejects.toMatchObject({ code: "CREDENTIAL_DECRYPTION_FAILED" });
    await expect(encryptConfiguration({}, btoa("short"))).rejects.toMatchObject(
      { code: "INVALID_ENCRYPTION_KEY" },
    );
  });
});
