import { afterEach, describe, expect, it, vi } from "vitest";

import { reconciliationDependencies } from "./dependencies.ts";

afterEach(() => vi.unstubAllGlobals());

function fixtureDependencies(body: string, publicUrl: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        articles: [
          {
            id: 20,
            locale: "en-US",
            draft: false,
            archived: false,
            user_segment_ids: [],
            user_segment_id: null,
            created_at: "2025-01-01T00:00:00Z",
            section_id: 40,
            label_names: [],
            promoted: false,
            translations: [
              {
                id: 30,
                locale: "en-US",
                draft: false,
                title: "Oversized article",
                body,
                html_url: publicUrl,
                updated_at: "2025-01-02T00:00:00Z",
                outdated: false,
              },
            ],
          },
        ],
        sections: [{ id: 40, locale: "en-US", name: "Start", category_id: 50 }],
        categories: [{ id: 50, locale: "en-US", name: "Help" }],
        meta: { has_more: false },
        links: { next: null },
      }),
    ),
  );
  return reconciliationDependencies({
    reconciliation: {
      revision: 1,
      connectorKey: "docs",
      zendeskSubdomain: "docs",
      locales: ["en-US"],
      target: "local",
    },
    brand: { id: "10", name: "Docs", subdomain: "docs" },
    secrets: {
      zendesk: {
        accountSubdomain: "account",
        email: "operator@example.com",
        apiToken: "secret",
      },
      searchstax: {
        updateEndpoint: "https://search.example/update",
        selectEndpoint: "https://search.example/select",
        token: "secret",
      },
    },
  });
}

async function enumerate(dependencies: ReturnType<typeof fixtureDependencies>) {
  const quarantined: unknown[] = [];
  await expect(
    dependencies.enumerate(
      "en-US",
      async () => undefined,
      (record) => quarantined.push(record),
    ),
  ).resolves.toEqual([]);
  return quarantined;
}

describe("runtime reconciliation dependencies", () => {
  it("quarantines an oversized normalized record with its stable public identity", async () => {
    const quarantined = await enumerate(
      fixtureDependencies(
        "x".repeat(2_100_000),
        "https://docs.example/articles/20",
      ),
    );
    expect(quarantined).toEqual([
      {
        id: "zdg_docs_20_en_us",
        articleId: "20",
        locale: "en_us",
        publicTitle: "Oversized article",
        publicUrl: "https://docs.example/articles/20",
        reasonCode: "RECORD_TOO_LARGE",
      },
    ]);
  });

  it("replaces an unsafe record URL with the selected public Zendesk path", async () => {
    const quarantined = await enumerate(
      fixtureDependencies("Body", "http://private.example/articles/20"),
    );
    expect(quarantined).toEqual([
      expect.objectContaining({
        articleId: "20",
        publicUrl: "https://docs.zendesk.com/hc/en-US/articles/20",
        reasonCode: "INVALID_SOURCE_RECORD",
      }),
    ]);
  });
});
