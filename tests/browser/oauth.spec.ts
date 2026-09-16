import { expect, test, type Page } from "@playwright/test";

const brand = { id: "1", name: "Help Center", subdomain: "fixture" };

const baseSetup = {
  configured: false,
  state: "unconfigured",
  revision: 1,
  brand,
  locales: ["en-us"],
  destinationName: "Fixture index",
  previewUrl: "https://preview.example.com/",
  oauthAvailable: true,
  zendeskAuth: "oauth",
  zendeskAccount: "fixture",
  zendeskConfigured: false,
  searchstaxConfigured: false,
};

const dashboard = {
  ...baseSetup,
  configured: true,
  state: "ready",
  zendeskConfigured: true,
  searchstaxConfigured: true,
};

async function mockSetupApi(
  page: Page,
  options: {
    setup?: typeof baseSetup;
    candidate?: { handle: string; accountSubdomain: string } | null;
    onZendeskValidate?: (body: Record<string, unknown>) => void;
    onZendeskSave?: (body: Record<string, unknown>) => void;
  } = {},
) {
  const setup = options.setup ?? baseSetup;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/setup") {
      await route.fulfill({ json: setup });
      return;
    }
    if (path === "/api/oauth/zendesk/candidate") {
      await route.fulfill({ json: options.candidate ?? null });
      return;
    }
    if (path === "/api/oauth/zendesk/start") {
      await route.fulfill({
        json: {
          authorizationUrl: `${new URL(request.url()).origin}/mock-zendesk/authorize`,
        },
      });
      return;
    }
    if (path === "/api/setup/zendesk/validate" && request.method() === "POST") {
      options.onZendeskValidate?.(
        request.postDataJSON() as Record<string, unknown>,
      );
      await route.fulfill({
        json: {
          brands: [brand],
          locales: [{ locale: "en-us", supported: true }],
        },
      });
      return;
    }
    if (path === "/api/credentials/zendesk" && request.method() === "PUT") {
      options.onZendeskSave?.(
        request.postDataJSON() as Record<string, unknown>,
      );
      await route.fulfill({ json: { ...dashboard, zendeskAuth: "oauth" } });
      return;
    }
    if (path === "/api/dashboard") {
      await route.fulfill({
        json: {
          setup,
          manifestCounts: [],
          activeRun: null,
          scheduler: { state: "disabled", retryAttempt: 0 },
          issues: [],
          incidents: [],
        },
      });
      return;
    }
    if (path === "/api/runs") {
      await route.fulfill({ json: { runs: [] } });
      return;
    }
    await route.fulfill({ json: {} });
  });
}

test("OAuth is the default setup path and sends the opaque candidate handle", async ({
  page,
}) => {
  const authorizationRequests: string[] = [];
  let validatedBody: Record<string, unknown> | undefined;
  await mockSetupApi(page, {
    candidate: {
      handle: "opaque-candidate-handle-7f3a",
      accountSubdomain: "fixture",
    },
    onZendeskValidate: (body) => {
      validatedBody = body;
    },
  });
  await page.route("**/mock-zendesk/authorize", async (route) => {
    authorizationRequests.push(route.request().url());
    await route.fulfill({ body: "<p>Zendesk authorization fixture</p>" });
  });
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Validate the service account" }),
  ).toBeVisible();
  await expect(page.getByLabel("Account subdomain")).toHaveValue("fixture");
  await expect(
    page.getByRole("button", { name: "Validate Zendesk" }),
  ).toBeEnabled();
  await expect(
    page.getByLabel("Use existing legacy API token temporarily"),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Validate Zendesk" }).click();

  expect(validatedBody).toEqual({
    accountSubdomain: "fixture",
    email: "",
    apiToken: "",
    oauthHandle: "opaque-candidate-handle-7f3a",
  });
  expect(authorizationRequests).toHaveLength(0);
  await expect(
    page.getByRole("heading", { name: "Choose one brand" }),
  ).toBeVisible();
});

test("OAuth start redirects through the intercepted Zendesk authorization page", async ({
  page,
}) => {
  const authorizationRequests: string[] = [];
  await mockSetupApi(page, { candidate: null });
  await page.route("**/mock-zendesk/authorize", async (route) => {
    authorizationRequests.push(route.request().url());
    await route.fulfill({ body: "<p>Zendesk authorization fixture</p>" });
  });
  await page.goto("/");

  await page.getByLabel("Account subdomain").fill("fixture");
  await page.getByRole("button", { name: "Connect to Zendesk" }).click();
  await expect(page.getByText("Zendesk authorization fixture")).toBeVisible();
  expect(authorizationRequests).toHaveLength(1);
});

test("OAuth callback failure is shown as an actionable setup error", async ({
  page,
}) => {
  await mockSetupApi(page);
  await page.goto("/?zendesk_oauth=failed");

  await expect(page.getByRole("alert")).toContainText(
    "Zendesk connection was not completed. Check the private connection and try again.",
  );
});

test("dashboard reconnect validates and saves the returned OAuth candidate", async ({
  page,
}) => {
  let savedBody: Record<string, unknown> | undefined;
  await mockSetupApi(page, {
    setup: dashboard,
    candidate: {
      handle: "opaque-reconnect-handle-91ab",
      accountSubdomain: "fixture",
    },
    onZendeskSave: (body) => {
      savedBody = body;
    },
  });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Validate and save Zendesk authorization",
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Validate and save Zendesk authorization" })
    .click();

  expect(savedBody).toEqual({
    accountSubdomain: "fixture",
    oauthHandle: "opaque-reconnect-handle-91ab",
  });
  await expect(
    page.getByRole("button", {
      name: "Validate and save Zendesk authorization",
    }),
  ).toHaveCount(0);
});
