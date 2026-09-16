import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DashboardView,
  ErrorMessage,
  LocaleChoices,
  ReadinessProgress,
  ReadinessTimingNotice,
  RecoveryConfirmation,
  SetupWizard,
} from "./App";
import { apiFailureMessage } from "./api";

type Dashboard = Parameters<typeof DashboardView>[0]["dashboard"];
type SafeRun = NonNullable<Dashboard["activeRun"]>;

const counts = {
  source: 12,
  created: 3,
  changed: 2,
  unchanged: 6,
  stale: 1,
  plannedDeletions: 1,
  successfulDeletions: 1,
  failedDeletions: 0,
  withheldDeletions: 0,
  warnings: 0,
  quarantined: 0,
};
const baseRun: SafeRun = {
  id: "run-1",
  workflowId: "workflow-1",
  state: "succeeded",
  counts,
  startedAt: "2026-08-02T12:00:00.000Z",
  updatedAt: "2026-08-02T12:01:00.000Z",
};

function dashboard(activeRun: SafeRun | null = null): Dashboard {
  return {
    setup: {
      configured: true,
      state: "ready",
      revision: 2,
      brand: { id: "1", name: "Help Center", subdomain: "help" },
      locales: ["en-us", "es-419"],
      destinationName: "POC index",
      previewUrl: "https://preview.example.com/",
      zendeskConfigured: true,
      searchstaxConfigured: true,
    },
    manifestCounts: [],
    activeRun,
    scheduler: { state: "disabled", retryAttempt: 0 },
    issues: [],
    incidents: [],
  };
}

describe("operator interface", () => {
  it("renders a labeled, write-only first-time setup step", () => {
    const markup = renderToStaticMarkup(<SetupWizard onComplete={vi.fn()} />);
    expect(markup).toContain("Step 1 of 4");
    expect(markup).toContain("Service-account email");
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Validate Zendesk");
  });

  it("explains unsupported locales and prevents their selection", () => {
    const markup = renderToStaticMarkup(
      <LocaleChoices
        choices={[
          { locale: "en-us", supported: true },
          {
            locale: "zz-test",
            supported: false,
            reason: "No approved SearchStax language field mapping.",
          },
        ]}
        selected={["en-us"]}
        onChange={vi.fn()}
      />,
    );
    expect(markup).toContain("zz-test");
    expect(markup).toContain("No approved SearchStax language field mapping.");
    expect(markup).toContain("disabled");
  });

  it("requires the exact fingerprint for local namespace adoption", () => {
    const fingerprint = "a".repeat(64);
    const mismatch = renderToStaticMarkup(
      <RecoveryConfirmation
        plan={{ recordCount: 131, fingerprint }}
        confirmation="wrong"
        busy={false}
        onConfirmation={vi.fn()}
        onBack={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    expect(mismatch).toContain("all 131 connector-owned destination IDs match");
    expect(mismatch).toContain("Namespace-recovery fingerprint");
    expect(mismatch).toContain("disabled");
    expect(mismatch).toContain(fingerprint);
    expect(mismatch).not.toContain("fixture-token");
  });

  it("shows adjacent safe failures for invalid credentials and probe cleanup", () => {
    const invalid = renderToStaticMarkup(
      <ErrorMessage message="Zendesk request failed." />,
    );
    const cleanup = renderToStaticMarkup(
      <ErrorMessage message="SearchStax probe cleanup was not confirmed." />,
    );
    expect(invalid).toContain('role="alert"');
    expect(invalid).toContain("Zendesk request failed.");
    expect(cleanup).toContain("probe cleanup was not confirmed");
  });

  it("renders actual readiness phase with elapsed time and countdown", () => {
    const markup = renderToStaticMarkup(
      <ReadinessProgress
        status={{
          phase: "waiting_for_visibility",
          startedAt: "2026-08-09T00:00:00.000Z",
          deadlineAt: "2026-08-09T00:01:00.000Z",
        }}
        now={Date.parse("2026-08-09T00:00:12.000Z")}
      />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain(
      "Waiting for SearchStax to make the test document searchable",
    );
    expect(markup).toContain("12 seconds elapsed");
    expect(markup).toContain("48 seconds remaining");
    expect(markup).not.toContain("probe ID");
    expect(markup).not.toContain("endpoint");
  });

  it("does not present the background timeout as an indexing estimate", () => {
    const markup = renderToStaticMarkup(
      <ReadinessProgress
        background
        status={{
          phase: "waiting_for_visibility",
          startedAt: "2026-09-07T00:00:00Z",
          deadlineAt: "2026-09-07T00:20:00Z",
        }}
        now={Date.parse("2026-09-07T00:00:05Z")}
      />,
    );
    expect(markup).toContain("Checks continue automatically");
    expect(markup).not.toContain("seconds remaining");
  });

  it("sets expectations for delayed SearchStax visibility", () => {
    const markup = renderToStaticMarkup(<ReadinessTimingNotice />);
    expect(markup).toContain("up to 10 minutes to reflect each change");
    expect(markup).toContain("about 20 minutes");
  });

  it("preserves only safe API failure codes for diagnosis", () => {
    expect(
      apiFailureMessage({
        error: {
          code: "PERMANENT_HTTP_FAILURE",
          message: "Zendesk request failed.",
        },
      }),
    ).toBe(
      "Connection rejected. Check the endpoint and token, then try again.",
    );
    expect(
      apiFailureMessage({
        error: { code: "unsafe details", message: "Zendesk request failed." },
      }),
    ).toBe("Zendesk request failed.");
  });

  it("shows saved setup progress and a concrete retry path without sync controls", () => {
    for (const state of ["destination_validated", "attention_required"]) {
      const current = dashboard();
      const markup = renderToStaticMarkup(
        <DashboardView
          dashboard={{ ...current, setup: { ...current.setup, state } }}
          runs={[]}
          refresh={vi.fn()}
        />,
      );
      expect(markup).not.toContain("Sync now");
      expect(markup).not.toContain("Enable scheduling");
      expect(markup).toContain(
        state === "destination_validated"
          ? "Your connection is saved"
          : "Retry index check",
      );
    }
  });

  it("renders returning setup, empty history, and the safe Preview link", () => {
    const markup = renderToStaticMarkup(
      <DashboardView dashboard={dashboard()} runs={[]} refresh={vi.fn()} />,
    );
    expect(markup).toContain("Help Center");
    expect(markup).toContain("Sync now");
    expect(markup).toContain("No acknowledged records yet");
    expect(markup).toContain("No completed runs yet");
    expect(markup).toContain("Open SearchStax Preview");
    expect(markup).toContain("Enable scheduling");
    expect(markup).toContain("Scheduling status: disabled");
    expect(markup).not.toContain("apiToken");
  });

  it("renders retry and pause scheduler details", () => {
    const markup = renderToStaticMarkup(
      <DashboardView
        dashboard={{
          ...dashboard(),
          scheduler: {
            state: "paused",
            retryAttempt: 2,
            nextRunAt: "2026-08-08T13:00:00.000Z",
            pauseReason: "retries_exhausted",
          },
        }}
        runs={[]}
        refresh={vi.fn()}
      />,
    );
    expect(markup).toContain("retries exhausted");
    expect(markup).toContain("Retry attempt");
    expect(markup).toContain("Enable scheduling");
  });

  it("renders active progress and cooperative cancellation", () => {
    const markup = renderToStaticMarkup(
      <DashboardView
        dashboard={dashboard({ ...baseRun, state: "writing" })}
        runs={[]}
        refresh={vi.fn()}
      />,
    );
    expect(markup).toContain("Current run");
    expect(markup).toContain("Cancel run");
    expect(markup).toContain("Unchanged");
  });

  it("requires the exact guarded-deletion fingerprint", () => {
    const markup = renderToStaticMarkup(
      <DashboardView
        dashboard={dashboard({
          ...baseRun,
          state: "guarded",
          deletionPlan: {
            id: "plan-1",
            staleCount: 4,
            exactIds: ["zdg_connector_4_en_us"],
            fingerprint: "abc123",
          },
        })}
        runs={[]}
        refresh={vi.fn()}
      />,
    );
    expect(markup).toContain("Review 4 stale records");
    expect(markup).toContain("abc123");
    expect(markup).toContain("Deletion-plan fingerprint");
    expect(markup).toContain("disabled");
  });

  it("shows redacted failure codes and run history", () => {
    const failed = {
      ...baseRun,
      state: "failed" as const,
      failureCode: "SOURCE_INCOMPLETE",
    };
    const markup = renderToStaticMarkup(
      <DashboardView
        dashboard={dashboard(failed)}
        runs={[failed]}
        refresh={vi.fn()}
      />,
    );
    expect(markup).toContain("Run stopped safely: SOURCE_INCOMPLETE");
    expect(markup).toContain("Latest activity");
  });

  it("renders a safe actionable issue with public context only", () => {
    const markup = renderToStaticMarkup(
      <DashboardView
        dashboard={{
          ...dashboard(),
          issues: [
            {
              articleId: "20",
              locale: "en_us",
              publicTitle: "Reset your password",
              publicUrl: "https://help.example.com/hc/en-us/articles/20",
              reasonCode: "RECORD_TOO_LARGE",
            },
          ],
        }}
        runs={[]}
        refresh={vi.fn()}
      />,
    );
    expect(markup).toContain("Needs attention");
    expect(markup).toContain("Reset your password");
    expect(markup).toContain("en_us");
    expect(markup).toContain("Record exceeds the destination request limit.");
    expect(markup).toContain(
      'href="https://help.example.com/hc/en-us/articles/20"',
    );
    expect(markup).not.toContain("document_json");
    expect(markup).not.toContain("raw response");
  });

  it("always renders safe incidents and explicit browser opt-in", () => {
    const markup = renderToStaticMarkup(
      <DashboardView
        dashboard={{
          ...dashboard(),
          incidents: [
            {
              key: "safe-key",
              phase: "failed",
              event: "run_failed",
              createdAt: "2026-08-09T00:00:00.000Z",
            },
          ],
        }}
        runs={[]}
        refresh={vi.fn()}
      />,
    );
    expect(markup).toContain("Recent incidents");
    expect(markup).toContain("A reconciliation stopped safely.");
    expect(markup).toContain("Enable browser alerts");
    expect(markup).not.toContain("safe-key");
  });

  it("renders canceled recovery as a terminal history state", () => {
    const canceled = { ...baseRun, state: "canceled" };
    const markup = renderToStaticMarkup(
      <DashboardView
        dashboard={dashboard()}
        runs={[canceled]}
        refresh={vi.fn()}
      />,
    );
    expect(markup).toContain("canceled");
    expect(markup).toContain("Sync now");
  });
});
