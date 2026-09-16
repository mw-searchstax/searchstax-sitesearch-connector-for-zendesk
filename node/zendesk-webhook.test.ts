import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  configuredZendeskLocale,
  parseZendeskArticleWebhook,
  verifyZendeskWebhookSignature,
} from "./zendesk-webhook.ts";

const secret = "webhook-secret";
const body = JSON.stringify({
  type: "zen:event-type:article.published",
  detail: { id: "20", brand_id: "10" },
  event: { locale: "en-US" },
});
const timestamp = "2026-09-09T12:00:00.000Z";
const now = () => Date.parse("2026-09-09T12:02:00.000Z");

function signature(value = body) {
  return createHmac("sha256", secret)
    .update(timestamp + value)
    .digest("base64");
}

describe("Zendesk webhook authentication", () => {
  it("preserves the configured API locale spelling for normalized events", () => {
    expect(configuredZendeskLocale(["en-US", "es-419"], "en_us")).toBe("en-US");
    expect(configuredZendeskLocale(["en-US", "es-419"], "fr")).toBeNull();
  });

  it("accepts the signed raw body and parses only supported identity", () => {
    expect(
      verifyZendeskWebhookSignature(secret, body, signature(), timestamp, now),
    ).toBe(true);
    expect(parseZendeskArticleWebhook(JSON.parse(body))).toEqual({
      action: "published",
      articleId: "20",
      brandId: "10",
      locale: "en_us",
    });
  });

  it("rejects missing, invalid, and tampered signatures", () => {
    expect(
      verifyZendeskWebhookSignature(secret, body, null, timestamp, now),
    ).toBe(false);
    expect(
      verifyZendeskWebhookSignature(secret, body, "invalid", timestamp, now),
    ).toBe(false);
    expect(
      verifyZendeskWebhookSignature(
        secret,
        `${body} `,
        signature(),
        timestamp,
        now,
      ),
    ).toBe(false);
  });

  it("rejects malformed, stale, and future signed timestamps", () => {
    expect(
      verifyZendeskWebhookSignature(
        secret,
        body,
        signature(),
        "not-a-date",
        now,
      ),
    ).toBe(false);
    expect(
      verifyZendeskWebhookSignature(
        secret,
        body,
        signature(),
        "2026-09-09T11:56:59.999Z",
        now,
      ),
    ).toBe(false);
    expect(
      verifyZendeskWebhookSignature(
        secret,
        body,
        signature(),
        "2026-09-09T12:07:00.001Z",
        now,
      ),
    ).toBe(false);
  });

  it("accepts the empty event object required by unpublish events", () => {
    expect(
      parseZendeskArticleWebhook({
        type: "zen:event-type:article.unpublished",
        detail: { id: 20, brand_id: 10 },
        event: {},
      }),
    ).toEqual({ action: "unpublished", articleId: "20", brandId: "10" });
  });

  it("rejects unsupported or malformed events without interpreting content", () => {
    expect(() =>
      parseZendeskArticleWebhook({
        type: "zen:event-type:article.vote_created",
        detail: { id: "20", brand_id: "10" },
        event: {},
      }),
    ).toThrowError(/unsupported/u);
    expect(() => parseZendeskArticleWebhook({ type: "bad" })).toThrowError(
      /unsupported/u,
    );
  });
});
