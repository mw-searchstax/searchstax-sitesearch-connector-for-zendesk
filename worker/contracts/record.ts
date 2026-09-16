import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

import { ContractError } from "./shared.ts";

export const TRANSFORM_VERSION = 1;
export const SEARCHSTAX_BODY_LIMIT_BYTES = 2_097_152;

export type Json =
  boolean | null | number | string | Json[] | { [key: string]: Json };

const languageByLocale: Readonly<Record<string, string>> = {
  ar: "ar",
  bg: "bg",
  ca: "ca",
  cs: "cs",
  da: "da",
  de: "de",
  el: "el",
  en: "en",
  en_ca: "en_ca",
  en_gb: "en_gb",
  en_hk: "en_hk",
  en_us: "en",
  es: "es",
  es_419: "es_419",
  et: "et",
  fa: "fa",
  fi: "fi",
  fr: "fr",
  fr_ca: "fr_ca",
  ga: "ga",
  hi: "hi",
  hr: "hr",
  hu: "hu",
  id: "id",
  it: "it",
  ja: "ja",
  ko: "ko",
  lv: "lv",
  nl: "nl",
  no: "no",
  pl: "pl",
  pt: "pt",
  pt_br: "pt_br",
  pt_pt: "pt",
  ro: "ro",
  ru: "ru",
  sk: "sk",
  sr: "sr",
  sv: "sv",
  sw: "sw",
  th: "th",
  tr: "tr",
  uk: "uk",
  vi: "vi",
  zh: "zh",
  zh_cn: "zh_cn",
  zh_tw: "zh",
};

export function normalizeLocale(locale: string): string {
  const normalized = locale.trim().toLowerCase().replaceAll("-", "_");
  if (!/^[a-z]{2,3}(?:_[a-z0-9]+)*$/u.test(normalized)) {
    throw new ContractError("INVALID_LOCALE", "Locale was invalid.");
  }
  return normalized;
}

export function languageFields(locale: string) {
  const normalizedLocale = normalizeLocale(locale);
  const language = languageByLocale[normalizedLocale];
  if (language === undefined) {
    throw new ContractError(
      "UNSUPPORTED_LOCALE",
      `Unsupported SearchStax locale: ${normalizedLocale}.`,
    );
  }
  return {
    normalizedLocale,
    language,
    title: `title_txt_${language}`,
    body: `body_text_txt_${language}`,
  } as const;
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function canonical(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON requires finite numbers.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object")
    throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
  if (ancestors.has(value))
    throw new TypeError("Canonical JSON does not support circular values.");
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return `[${value.map((entry) => canonical(entry, ancestors)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("Canonical JSON requires plain objects.");
    const entries = Object.keys(value)
      .sort(compareCodePoints)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], ancestors)}`,
      );
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonical(value, new WeakSet());
}

const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "main",
  "nav",
  "p",
  "pre",
  "section",
  "table",
  "tr",
]);
const OMIT = new Set(["noscript", "script", "style", "svg", "template"]);

function attribute(element: DefaultTreeAdapterTypes.Element, name: string) {
  return element.attrs.find((candidate) => candidate.name === name)?.value;
}

function htmlText(
  node: DefaultTreeAdapterTypes.ChildNode,
  parts: string[],
  pre = false,
): void {
  if ("value" in node) {
    parts.push(pre ? node.value : node.value.replaceAll(/\s+/gu, " "));
    return;
  }
  if (!("tagName" in node)) return;
  const tag = node.tagName.toLowerCase();
  if (
    OMIT.has(tag) ||
    attribute(node, "hidden") !== undefined ||
    attribute(node, "aria-hidden")?.toLowerCase() === "true"
  )
    return;
  if (tag === "br") parts.push("\n");
  if (BLOCKS.has(tag) || tag === "li") parts.push("\n");
  if (tag === "li") parts.push("- ");
  if (tag === "img") {
    const alt = attribute(node, "alt")?.trim();
    if (alt) parts.push(alt);
  }
  for (const child of node.childNodes)
    htmlText(child, parts, pre || tag === "pre");
  if (BLOCKS.has(tag)) parts.push("\n");
}

export function htmlToText(html: string): string {
  const fragment = parseFragment(html);
  const parts: string[] = [];
  for (const child of fragment.childNodes) htmlText(child, parts);
  return parts
    .join("")
    .replaceAll(/[ \t]+\n/gu, "\n")
    .replaceAll(/\n[ \t]+/gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .replaceAll(/[ \t]{2,}/gu, " ")
    .trim();
}

function required(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed)
    throw new ContractError("INVALID_RECORD", `${name} is required.`);
  return trimmed;
}

function isoDate(name: string, value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new ContractError("INVALID_RECORD", `${name} was invalid.`);
  return date.toISOString();
}

function httpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ContractError("INVALID_RECORD", "URL was invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new ContractError("INVALID_RECORD", "URL was unsafe.");
  return url.toString();
}

export interface RecordInput {
  connectorKey: string;
  brandId: string;
  brandName: string;
  articleId: string;
  translationId: string;
  locale: string;
  title: string;
  bodyHtml: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  sectionId: string;
  sectionName: string;
  categoryId: string;
  categoryName: string;
  labels: readonly string[];
  promoted: boolean;
  outdated: boolean;
}

export interface PreparedRecord {
  id: string;
  document: Record<string, Json>;
  canonical: string;
  hash: string;
  byteSize: number;
  warnings: readonly ["EMPTY_BODY"] | readonly [];
}

export async function prepareRecordForDestinationId(
  record: PreparedRecord,
  destinationId: string,
): Promise<PreparedRecord> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(destinationId))
    throw new ContractError("INVALID_RECORD", "Destination ID was invalid.");
  const document = { ...record.document, id: destinationId };
  const canonical = canonicalJson(document);
  const canonicalEnvelope = canonicalJson({
    transformVersion: TRANSFORM_VERSION,
    record: document,
  });
  const byteSize = new TextEncoder().encode(canonical).byteLength;
  if (byteSize >= SEARCHSTAX_BODY_LIMIT_BYTES)
    throw new ContractError(
      "RECORD_TOO_LARGE",
      "Normalized document was too large.",
    );
  return {
    ...record,
    id: destinationId,
    document,
    canonical,
    hash: await sha256(canonicalEnvelope),
    byteSize,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function prepareRecord(
  input: RecordInput,
): Promise<PreparedRecord> {
  const connectorKey = required("connectorKey", input.connectorKey);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(connectorKey))
    throw new ContractError("INVALID_RECORD", "connectorKey was invalid.");
  for (const [name, value] of [
    ["brandId", input.brandId],
    ["articleId", input.articleId],
    ["translationId", input.translationId],
    ["sectionId", input.sectionId],
    ["categoryId", input.categoryId],
  ] as const) {
    if (!/^\d+$/u.test(value))
      throw new ContractError(
        "INVALID_RECORD",
        `${name} must be a decimal string.`,
      );
  }
  const fields = languageFields(input.locale);
  const body = htmlToText(input.bodyHtml ?? "");
  const id = `zdg_${connectorKey}_${input.articleId}_${fields.normalizedLocale}`;
  const document: Record<string, Json> = {
    id,
    connector_key_s: connectorKey,
    source_system_s: "zendesk",
    source_type_s: "guide_article",
    source_brand_id_s: input.brandId,
    source_brand_s: required("brandName", input.brandName),
    zendesk_article_id_s: input.articleId,
    zendesk_translation_id_s: input.translationId,
    locale_s: fields.normalizedLocale,
    [fields.title]: required("title", input.title),
    [fields.body]: body,
    url_s: httpsUrl(input.url),
    created_at_dt: isoDate("createdAt", input.createdAt),
    updated_at_dt: isoDate("updatedAt", input.updatedAt),
    section_id_s: input.sectionId,
    section_name_s: required("sectionName", input.sectionName),
    category_id_s: input.categoryId,
    category_name_s: required("categoryName", input.categoryName),
    label_names_ss: [
      ...new Set(input.labels.map((label) => label.trim()).filter(Boolean)),
    ].sort(compareCodePoints),
    promoted_b: input.promoted,
    outdated_b: input.outdated,
    visibility_s: "public",
  };
  const serialized = canonicalJson(document);
  const canonicalEnvelope = canonicalJson({
    transformVersion: TRANSFORM_VERSION,
    record: document,
  });
  const byteSize = new TextEncoder().encode(serialized).byteLength;
  if (byteSize >= SEARCHSTAX_BODY_LIMIT_BYTES)
    throw new ContractError(
      "RECORD_TOO_LARGE",
      "Normalized document was too large.",
    );
  return {
    id,
    document,
    canonical: serialized,
    hash: await sha256(canonicalEnvelope),
    byteSize,
    warnings: body ? [] : ["EMPTY_BODY"],
  };
}
