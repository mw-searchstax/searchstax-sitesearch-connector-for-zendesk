import { expect, test, type Page } from "@playwright/test";

const counts = {
  source: 12,
  created: 3,
  changed: 2,
  unchanged: 6,
  stale: 1,
  plannedDeletions: 0,
  successfulDeletions: 0,
  failedDeletions: 0,
  withheldDeletions: 0,
  warnings: 0,
  quarantined: 0,
};

const setup = {
  configured: true,
  state: "ready",
  revision: 2,
  brand: { id: "1", name: "Help Center", subdomain: "help" },
  locales: ["en-us", "es-419"],
  destinationName: "POC index",
  previewUrl: "https://preview.example.com/",
  zendeskConfigured: true,
  searchstaxConfigured: true,
};

interface MockScheduler {
  state: "disabled" | "enabled" | "paused";
  retryAttempt: number;
  nextRunAt?: string;
  pauseReason?: "operator";
}

async function mockApi(
  page: Page,
  options: {
    configured?: boolean;
    guarded?: boolean;
    issues?: boolean;
    incidents?: boolean;
    readiness?: boolean;
    scheduler?: MockScheduler;
  } = {},
) {
  let scheduler: MockScheduler = options.scheduler ?? {
    state: "disabled",
    retryAttempt: 0,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/setup/searchstax/status") {
      await route.fulfill({
        json: options.readiness
          ? {
              phase: "waiting_for_visibility",
              startedAt: new Date(Date.now() - 12_000).toISOString(),
              deadlineAt: new Date(Date.now() + 48_000).toISOString(),
            }
          : null,
      });
      return;
    }
    if (
      options.readiness &&
      path === "/api/credentials/searchstax" &&
      route.request().method() === "PUT"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({
        status: 400,
        json: {
          error: {
            code: "READINESS_TIMEOUT",
            message: "SearchStax readiness validation timed out. Try again.",
          },
        },
      });
      return;
    }
    if (path === "/api/scheduler" && route.request().method() === "PUT") {
      const input = route.request().postDataJSON() as { enabled: boolean };
      scheduler = input.enabled
        ? { state: "enabled", retryAttempt: 0 }
        : { state: "paused", retryAttempt: 0, pauseReason: "operator" };
      await route.fulfill({ json: scheduler });
      return;
    }
    const configured = options.configured ?? true;
    if (path === "/api/setup") {
      await route.fulfill({
        json: configured
          ? setup
          : {
              configured: false,
              state: "unconfigured",
              zendeskConfigured: false,
              searchstaxConfigured: false,
            },
      });
      return;
    }
    if (path === "/api/dashboard") {
      await route.fulfill({
        json: {
          setup,
          manifestCounts: [
            { locale: "en-us", count: 8 },
            { locale: "es-419", count: 4 },
          ],
          scheduler,
          incidents: options.incidents
            ? [
                {
                  key: "incident-1",
                  phase: "failed",
                  event: "run_failed",
                  createdAt: "2026-08-09T00:00:00.000Z",
                },
              ]
            : [],
          issues: options.issues
            ? [
                {
                  articleId: "20",
                  locale: "en_us",
                  publicTitle: "Reset your password",
                  publicUrl: "https://help.example.com/hc/en-us/articles/20",
                  reasonCode: "RECORD_TOO_LARGE",
                },
              ]
            : [],
          activeRun: options.guarded
            ? {
                id: "run-1",
                workflowId: "workflow-1",
                state: "guarded",
                counts,
                startedAt: "2026-08-02T12:00:00.000Z",
                updatedAt: "2026-08-02T12:01:00.000Z",
                deletionPlan: {
                  id: "plan-1",
                  staleCount: 4,
                  exactIds: ["doc-1", "doc-2", "doc-3", "doc-4"],
                  fingerprint: "abc123",
                },
              }
            : null,
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

test("first-run setup is keyboard reachable at 1280 by 720", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockApi(page, { configured: false });
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Validate the service account" }),
  ).toBeVisible();
  await expect(page.getByLabel("Account subdomain")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Service-account email")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Zendesk API token")).toBeFocused();
  await expect(page.locator("body")).toHaveCSS("overflow-x", "visible");
});

test("guard confirmation and narrow layout remain operable with reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockApi(page, { guarded: true });
  await page.goto("/");

  const confirm = page.getByRole("button", { name: "Confirm exact deletion" });
  await expect(
    page.getByRole("heading", { name: "Review 4 stale records" }),
  ).toBeVisible();
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Deletion-plan fingerprint").fill("wrong");
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Deletion-plan fingerprint").fill("abc123");
  await expect(confirm).toBeEnabled();
  await expect(page.locator(".app-shell")).toHaveCSS("width", "358px");
  await expect(
    page.getByRole("button", { name: "Enable scheduling" }),
  ).toBeVisible();
  const animationDuration = await page
    .locator(".guarded")
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).animationDuration),
    );
  expect(animationDuration).toBeLessThanOrEqual(0.00001);
});

test("scheduler controls are keyboard reachable and persist pause state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockApi(page);
  await page.goto("/");

  const enable = page.getByRole("button", { name: "Enable scheduling" });
  await expect(enable).toBeVisible();
  await enable.focus();
  await expect(enable).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Pause scheduling" }),
  ).toBeVisible();
  await expect(page.getByLabel("Scheduling status: enabled")).toBeVisible();
  await page.getByRole("button", { name: "Pause scheduling" }).click();
  await expect(
    page.getByRole("button", { name: "Enable scheduling" }),
  ).toBeVisible();
  await expect(page.getByText("operator", { exact: true })).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("overflow-x", "visible");
});

test("scheduler retry timing remains visible in the operator dashboard", async ({
  page,
}) => {
  await mockApi(page, {
    scheduler: {
      state: "enabled",
      retryAttempt: 2,
      nextRunAt: "2026-08-08T00:20:00.000Z",
    },
  });
  await page.goto("/");

  await expect(page.getByLabel("Scheduling status: retrying")).toBeVisible();
  await expect(page.getByText("2 of 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Next run", { exact: true })).toBeVisible();
});

test("credential readiness shows actual progress and an actionable timeout", async ({
  page,
}) => {
  await mockApi(page, { readiness: true });
  await page.goto("/");
  await page
    .getByText("Replace SearchStax credentials", { exact: true })
    .click();
  await expect(
    page.getByText(/up to 10 minutes to reflect each change/u),
  ).toBeVisible();
  await expect(page.getByText(/about 20 minutes/u)).toBeVisible();
  await page.getByLabel("Update endpoint").fill("https://example.com/update");
  await page
    .getByLabel("Search endpoint (/emselect or /select)")
    .fill("https://example.com/select");
  await page.getByLabel("New Read & Write token").fill("fixture-token");
  await page.getByRole("button", { name: "Run probe and replace" }).click();

  const progress = page.getByRole("status");
  await expect(progress).toContainText(
    "Waiting for SearchStax to make the test document searchable",
  );
  await expect(progress).toContainText("seconds elapsed");
  await expect(progress).toContainText("seconds remaining");
  await expect(page.getByRole("alert")).toContainText(
    "The index hasn’t caught up yet. Retry the index check.",
  );
  await expect(
    page.getByRole("button", { name: "Run probe and replace" }),
  ).toBeEnabled();
});

test("quarantined articles expose only actionable public context", async ({
  page,
}) => {
  await mockApi(page, { issues: true });
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Quarantined articles" }),
  ).toBeVisible();
  const article = page.getByRole("link", { name: "Reset your password" });
  await expect(article).toHaveAttribute(
    "href",
    "https://help.example.com/hc/en-us/articles/20",
  );
  await expect(page.getByText("en_us", { exact: false })).toBeVisible();
  await expect(
    page.getByText("Record exceeds the destination request limit."),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("document_json");
  await expect(page.locator("body")).not.toContainText("raw response");
});

test("browser incident alerts require permission and deduplicate across reload", async ({
  page,
}) => {
  await page.addInitScript(() => {
    class FakeNotification {
      static permission = localStorage.getItem(
        "zendesk-connector-notifications",
      )
        ? "granted"
        : "default";

      static async requestPermission() {
        localStorage.setItem("notification-permission-requests", "1");
        FakeNotification.permission = "granted";
        return "granted";
      }

      constructor() {
        const count = Number(localStorage.getItem("notification-count") ?? 0);
        localStorage.setItem("notification-count", String(count + 1));
      }
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: FakeNotification,
    });
  });
  await mockApi(page, { incidents: true });
  await page.goto("/");

  await page.getByRole("button", { name: "Enable browser alerts" }).click();
  await expect(
    page.getByRole("button", { name: "Disable browser alerts" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("notification-permission-requests"),
      ),
    )
    .toBe("1");

  await page.evaluate(() =>
    localStorage.removeItem("zendesk-connector-last-notification"),
  );
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("notification-count")))
    .toBe("1");
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("notification-count")))
    .toBe("1");
});

test("saved setup survives reload and exposes retry without sync controls", async ({
  page,
}) => {
  let state = "destination_validated";
  let retries = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const pendingSetup = { ...setup, state };
    if (path === "/api/setup/retry") {
      retries++;
      state = "destination_validated";
      await route.fulfill({ status: 202, json: pendingSetup });
      return;
    }
    if (path === "/api/setup") {
      await route.fulfill({ json: pendingSetup });
      return;
    }
    if (path === "/api/dashboard") {
      await route.fulfill({
        json: {
          setup: pendingSetup,
          scheduler: { state: "disabled", retryAttempt: 0 },
          manifestCounts: [],
          activeRun: null,
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
    await route.fulfill({ json: null });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your connection is saved" }),
  ).toBeVisible();
  await expect(
    page.getByText(/You can leave this page and come back/u),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your connection is saved" }),
  ).toBeVisible();
  state = "attention_required";
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Retry index check" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry index check" }).click();
  await expect(
    page.getByRole("heading", { name: "Your connection is saved" }),
  ).toBeVisible();
  expect(retries).toBe(1);
});

test("wizard saves credentials and opens the dashboard while indexing is pending", async ({
  page,
}, testInfo) => {
  let saved = false;
  let checks = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const pending = { ...setup, state: "destination_validated" };
    if (path === "/api/setup/zendesk/validate") {
      await route.fulfill({
        json: {
          brands: [setup.brand],
          locales: [{ locale: "en-us", supported: true }],
        },
      });
      return;
    }
    if (path === "/api/setup/searchstax/validate") {
      checks++;
      await route.fulfill({ json: { connectionValidated: true } });
      return;
    }
    if (path === "/api/setup/complete") {
      saved = true;
      await route.fulfill({ status: 201, json: pending });
      return;
    }
    if (path === "/api/setup") {
      await route.fulfill({
        json: saved
          ? pending
          : {
              configured: false,
              state: "unconfigured",
              zendeskConfigured: false,
              searchstaxConfigured: false,
            },
      });
      return;
    }
    if (path === "/api/dashboard") {
      await route.fulfill({
        json: {
          setup: pending,
          scheduler: { state: "disabled", retryAttempt: 0 },
          manifestCounts: [],
          activeRun: null,
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
    await route.fulfill({ json: null });
  });
  await page.goto("/");
  await page.getByLabel("Account subdomain").fill("fixture");
  await page.getByLabel("Service-account email").fill("operator@example.com");
  await page.getByLabel("Zendesk API token").fill("fixture-token");
  await page.getByRole("button", { name: "Validate Zendesk" }).click();
  await page.getByLabel("Accessible brand").selectOption("1");
  await page.getByRole("button", { name: "Discover locales" }).click();
  await page.getByLabel("Connector key").fill("fixture");
  await page.getByLabel("Destination name").fill("Test index");
  await page.getByLabel("Update endpoint").fill("https://example.com/update");
  await page
    .getByLabel("Search endpoint (/emselect or /select)")
    .fill("https://example.com/emselect");
  await page
    .getByLabel("Read & Write token", { exact: true })
    .fill("fixture-token");
  await page.getByRole("button", { name: "Check connection" }).click();
  await page.getByRole("button", { name: "Complete setup" }).click();
  await expect(
    page.getByRole("heading", { name: "Your connection is saved" }),
  ).toBeVisible();
  expect(checks).toBe(1);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("setup-pending.png"),
    fullPage: true,
  });
});
