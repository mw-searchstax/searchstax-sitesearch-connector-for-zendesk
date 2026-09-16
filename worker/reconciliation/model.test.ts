import { describe, expect, it } from "vitest";

import { canonicalZendeskSourceIdentity, sourceIdentityKey } from "./model.ts";

describe("reconciliation identity model", () => {
  it("canonicalizes only the configured source identity", () => {
    const first = canonicalZendeskSourceIdentity(" Docs ", "20", "en-US");
    const second = canonicalZendeskSourceIdentity("docs", "20", "en_us");

    expect(first).toEqual({
      subdomain: "docs",
      articleId: "20",
      locale: "en_us",
    });
    expect(sourceIdentityKey(first)).toBe(sourceIdentityKey(second));
  });

  it("preserves absolute decimal article identity and rejects non-decimal IDs", () => {
    expect(
      canonicalZendeskSourceIdentity("docs", "00020", "en-US").articleId,
    ).toBe("00020");
    expect(() =>
      canonicalZendeskSourceIdentity("docs", "20.1", "en-US"),
    ).toThrow("absolute decimal");
  });
});
