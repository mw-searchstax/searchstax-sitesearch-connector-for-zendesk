import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  htmlToText,
  languageFields,
  prepareRecord,
  prepareRecordForDestinationId,
  TRANSFORM_VERSION,
  type RecordInput,
} from "./record.ts";

const input: RecordInput = {
  connectorKey: "docs-main",
  brandId: "10",
  brandName: " Docs ",
  articleId: "20",
  translationId: "30",
  locale: "en-US",
  title: " Hello ",
  bodyHtml:
    "<p>Hello&nbsp; <strong>world</strong></p><script>secret</script><ul><li>One</li><li>Two</li></ul>",
  url: "https://docs.example.com/hc/en-us/articles/20",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-02T01:02:03-05:00",
  sectionId: "40",
  sectionName: " Start ",
  categoryId: "50",
  categoryName: " Help ",
  labels: [" beta ", "alpha", "beta", ""],
  promoted: true,
  outdated: false,
};

describe("record contract", () => {
  it("normalizes HTML into deterministic visible clean text", () => {
    expect(htmlToText(input.bodyHtml!)).toBe("Hello world\n\n- One\n- Two");
    expect(
      htmlToText(
        "<p aria-hidden='true'>hidden</p><p><img alt='Diagram'>Shown<br>next</p>",
      ),
    ).toBe("DiagramShown\nnext");
  });

  it("uses canonical Unicode code-point key order and rejects unsupported values", () => {
    expect(canonicalJson({ "😀": "emoji", "": "bmp", a: [1, true] })).toBe(
      '{"a":[1,true],"":"bmp","😀":"emoji"}',
    );
    expect(() => canonicalJson(Number.NaN)).toThrow(/finite/u);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(/circular/u);
  });

  it.each([
    ["en-US", "en"],
    ["en-GB", "en_gb"],
    ["fr-CA", "fr_ca"],
    ["pt-BR", "pt_br"],
    ["zh-TW", "zh"],
    ["es-419", "es_419"],
  ])("maps %s only through the explicit language table", (locale, language) => {
    expect(languageFields(locale)).toMatchObject({
      language,
      title: `title_txt_${language}`,
      body: `body_text_txt_${language}`,
    });
  });

  it("rejects unsupported locales instead of falling back", () => {
    expect(() => languageFields("fr-FR")).toThrow(/Unsupported/u);
  });

  it("maps every fixed physical field and hashes the transform envelope", async () => {
    const prepared = await prepareRecord(input);
    expect(prepared.id).toBe("zdg_docs-main_20_en_us");
    expect(prepared.document).toEqual({
      id: "zdg_docs-main_20_en_us",
      connector_key_s: "docs-main",
      source_system_s: "zendesk",
      source_type_s: "guide_article",
      source_brand_id_s: "10",
      source_brand_s: "Docs",
      zendesk_article_id_s: "20",
      zendesk_translation_id_s: "30",
      locale_s: "en_us",
      title_txt_en: "Hello",
      body_text_txt_en: "Hello world\n\n- One\n- Two",
      url_s: "https://docs.example.com/hc/en-us/articles/20",
      created_at_dt: "2025-01-01T00:00:00.000Z",
      updated_at_dt: "2025-01-02T06:02:03.000Z",
      section_id_s: "40",
      section_name_s: "Start",
      category_id_s: "50",
      category_name_s: "Help",
      label_names_ss: ["alpha", "beta"],
      promoted_b: true,
      outdated_b: false,
      visibility_s: "public",
    });
    expect(prepared.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(TRANSFORM_VERSION).toBe(1);
    expect(prepared.warnings).toEqual([]);
  });

  it("warns for null body and produces a stable hash", async () => {
    const first = await prepareRecord({ ...input, bodyHtml: null });
    const second = await prepareRecord({ ...input, bodyHtml: "" });
    expect(first.warnings).toEqual(["EMPTY_BODY"]);
    expect(first.hash).toBe(second.hash);
  });

  it("recomputes the canonical hash when preserving an existing destination ID", async () => {
    const prepared = await prepareRecord(input);
    const adopted = await prepareRecordForDestinationId(prepared, "legacy-20");
    expect(adopted.id).toBe("legacy-20");
    expect(adopted.document.id).toBe("legacy-20");
    expect(adopted.hash).not.toBe(prepared.hash);
    expect(adopted.hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects an oversized normalized singleton without truncation", async () => {
    await expect(
      prepareRecord({ ...input, bodyHtml: "x".repeat(2_100_000) }),
    ).rejects.toThrow(/too large/u);
  });

  it.each([
    ["connector key", { connectorKey: "Bad Key" }],
    ["decimal identity", { articleId: "20.1" }],
    ["title", { title: " " }],
    ["date", { updatedAt: "not-a-date" }],
    ["URL", { url: "http://unsafe.example.com" }],
    ["hierarchy", { categoryName: " " }],
  ])("fails malformed required %s", async (_name, changed) => {
    await expect(prepareRecord({ ...input, ...changed })).rejects.toThrow();
  });
});
