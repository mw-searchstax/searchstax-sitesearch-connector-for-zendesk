import { createHmac, timingSafeEqual } from "node:crypto";

import { ContractError } from "../worker/contracts/shared.ts";
import { normalizeLocale } from "../worker/contracts/record.ts";

export type ZendeskArticleWebhookAction = "published" | "unpublished";

export interface ZendeskArticleWebhookEvent {
  action: ZendeskArticleWebhookAction;
  articleId: string;
  brandId: string;
  locale?: string;
}

export const ZENDESK_WEBHOOK_FRESHNESS_WINDOW_MS = 5 * 60 * 1_000;

export function configuredZendeskLocale(
  locales: readonly string[],
  normalizedLocale: string,
): string | null {
  return (
    locales.find((locale) => normalizeLocale(locale) === normalizedLocale) ??
    null
  );
}

export function verifyZendeskWebhookSignature(
  secret: string,
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  now: () => number = Date.now,
): boolean {
  if (!secret.trim() || !signature?.trim() || !timestamp?.trim()) return false;
  const timestampMs = Date.parse(timestamp);
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(now() - timestampMs) > ZENDESK_WEBHOOK_FRESHNESS_WINDOW_MS
  )
    return false;
  const expected = createHmac("sha256", secret)
    .update(timestamp + rawBody)
    .digest("base64");
  const supplied = Buffer.from(signature);
  const actual = Buffer.from(expected);
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

function decimal(value: unknown, name: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^\d+$/u.test(String(value))
  )
    throw new ContractError("INVALID_WEBHOOK", `${name} was invalid.`);
  return String(value);
}

export function parseZendeskArticleWebhook(
  value: unknown,
): ZendeskArticleWebhookEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractError("INVALID_WEBHOOK", "Webhook payload was invalid.");
  const payload = value as Record<string, unknown>;
  const type = payload.type;
  const detail = payload.detail;
  if (typeof type !== "string" || !type.startsWith("zen:event-type:article."))
    throw new ContractError(
      "UNSUPPORTED_WEBHOOK",
      "Webhook event was unsupported.",
    );
  const action = type.endsWith(".published")
    ? "published"
    : type.endsWith(".unpublished")
      ? "unpublished"
      : null;
  if (!action || !detail || typeof detail !== "object" || Array.isArray(detail))
    throw new ContractError(
      action ? "INVALID_WEBHOOK" : "UNSUPPORTED_WEBHOOK",
      action
        ? "Webhook payload was invalid."
        : "Webhook event was unsupported.",
    );
  const article = detail as Record<string, unknown>;
  const event = payload.event;
  if (action === "unpublished") {
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      Object.keys(event).length !== 0
    )
      throw new ContractError(
        "INVALID_WEBHOOK",
        "Webhook payload was invalid.",
      );
    return {
      action,
      articleId: decimal(article.id, "Article ID"),
      brandId: decimal(article.brand_id, "Brand ID"),
    };
  }
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw new ContractError("INVALID_WEBHOOK", "Webhook payload was invalid.");
  const eventData = event as Record<string, unknown>;
  let locale: string;
  try {
    locale = normalizeLocale(String(eventData.locale));
  } catch {
    throw new ContractError("INVALID_WEBHOOK", "Article locale was invalid.");
  }
  return {
    action,
    articleId: decimal(article.id, "Article ID"),
    brandId: decimal(article.brand_id, "Brand ID"),
    locale,
  };
}
