import { useCallback, useEffect, useState, type FormEvent } from "react";

import "./app.css";
import { apiFailureMessage, type ApiFailure } from "./api";

interface SafeSetup {
  configured: boolean;
  state: string;
  revision?: number;
  brand?: { id: string; name: string; subdomain: string };
  locales?: readonly string[];
  destinationName?: string;
  previewUrl?: string;
  oauthAvailable?: boolean;
  zendeskAuth?: "legacy" | "oauth" | "reconnect_required";
  zendeskAccount?: string;
  zendeskConfigured: boolean;
  searchstaxConfigured: boolean;
}

interface SafeRun {
  id: string;
  workflowId: string;
  state: string;
  counts: {
    source: number;
    created: number;
    changed: number;
    unchanged: number;
    stale: number;
    plannedDeletions: number;
    successfulDeletions: number;
    failedDeletions: number;
    withheldDeletions: number;
    warnings: number;
    quarantined: number;
  };
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  failureCode?: string;
  deletionPlan?: {
    id: string;
    staleCount: number;
    exactIds: readonly string[];
    fingerprint: string;
  };
}

interface SafeScheduler {
  state: "disabled" | "enabled" | "paused";
  retryAttempt: number;
  nextRunAt?: string;
  pauseReason?:
    "operator" | "guarded_action" | "permanent_failure" | "retries_exhausted";
}

interface Dashboard {
  setup: SafeSetup;
  manifestCounts: readonly { locale: string; count: number }[];
  activeRun: SafeRun | null;
  scheduler: SafeScheduler;
  issues: readonly {
    articleId: string;
    locale: string;
    publicTitle: string;
    publicUrl: string;
    reasonCode: string;
  }[];
  incidents: readonly {
    key: string;
    phase: string;
    event: string;
    createdAt: string;
    attempt?: number;
  }[];
}

interface ExistingIndexDryRun {
  readOnly: true;
  fingerprint: string;
  fieldAvailability: Record<
    "url" | "url_s" | "ss_url",
    | { state: "queryable" }
    | { state: "unavailable"; reasonCode: "UNDEFINED_FIELD" }
  >;
  counts: {
    sourceIdentities: number;
    candidates: number;
    managed: number;
    adopt: number;
    consolidate: number;
    create: number;
    ambiguousUnmatched: number;
  };
  actions: readonly {
    classification: string;
    sourceIdentity?: { subdomain: string; articleId: string; locale: string };
    candidateDestinationIds: readonly string[];
    proposedDestinationId?: string;
    redundantDestinationIds: readonly string[];
    reasonCode?: string;
  }[];
}

interface ExistingIndexApplyResult {
  status: "applied" | "rejected" | "partial" | "failed";
  reviewedFingerprint: string;
  recomputedFingerprint: string;
  counts: {
    managed: number;
    adopted: number;
    created: number;
    consolidated: number;
    redundantDeleted: number;
    failedWrites: number;
    failedRedundantDeletes: number;
    unresolvedResiduals: number;
    ambiguousUnmatched: number;
  };
  unresolvedResiduals: readonly string[];
  finalVerification: "passed" | "failed" | "not_run";
  reasonCode?: string;
  message?: string;
}

const notificationsEnabledKey = "zendesk-connector-notifications";
const lastNotificationKey = "zendesk-connector-last-notification";

function incidentReason(event: string) {
  return (
    {
      deletion_guarded: "A deletion plan needs exact confirmation.",
      retry_scheduled: "A failed automatic run is scheduled to retry.",
      run_canceled: "A reconciliation was canceled.",
      run_degraded: "A reconciliation completed with quarantined articles.",
      run_failed: "A reconciliation stopped safely.",
      scheduler_paused: "Scheduling paused after an incident.",
    }[event] ?? "The connector needs attention."
  );
}

function notifyLatestIncident(incidents: Dashboard["incidents"]) {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    window.localStorage.getItem(notificationsEnabledKey) !== "true" ||
    Notification.permission !== "granted"
  )
    return false;
  const latest = incidents[0];
  if (
    !latest ||
    window.localStorage.getItem(lastNotificationKey) === latest.key
  )
    return false;
  new Notification("Zendesk Connector needs attention", {
    body: incidentReason(latest.event),
  });
  window.localStorage.setItem(lastNotificationKey, latest.key);
  return true;
}

interface ZendeskValidation {
  brands: readonly { id: string; name: string; subdomain: string }[];
  locales: readonly { locale: string; supported: boolean; reason?: string }[];
}

interface LocalePlan {
  id: string;
  locales: readonly string[];
  removedRecordCount: number;
  fingerprint: string;
}

interface NamespaceRecoveryPlan {
  recordCount: number;
  fingerprint: string;
}

interface ReadinessStatus {
  phase:
    | "checking_namespace"
    | "recovering_cleanup"
    | "writing"
    | "waiting_for_visibility"
    | "deleting"
    | "confirming_cleanup";
  startedAt: string;
  deadlineAt: string;
}

const readinessPhase: Record<ReadinessStatus["phase"], string> = {
  checking_namespace: "Checking index access",
  recovering_cleanup: "Finishing the previous index check",
  writing: "Checking write access",
  waiting_for_visibility:
    "Waiting for SearchStax to make the test document searchable",
  deleting: "Removing the test document",
  confirming_cleanup: "Confirming test document removal",
};

export function ReadinessTimingNotice() {
  return (
    <p className="muted small">
      SearchStax can take up to 10 minutes to reflect each change. Full
      validation can take about 20 minutes because the readiness probe must also
      be removed.
    </p>
  );
}

export function ReadinessProgress({
  status,
  now,
  background = false,
}: {
  status: ReadinessStatus;
  now: number;
  background?: boolean;
}) {
  const elapsed = Math.max(
    0,
    Math.floor((now - Date.parse(status.startedAt)) / 1_000),
  );
  const remaining = Math.max(
    0,
    Math.ceil((Date.parse(status.deadlineAt) - now) / 1_000),
  );
  return (
    <div className="notice" role="status" aria-live="polite">
      <strong>{readinessPhase[status.phase]}.</strong>{" "}
      {background
        ? "Checks continue automatically."
        : `${elapsed} seconds elapsed · ${remaining} seconds remaining`}
    </div>
  );
}

function useReadinessProgress(active: boolean) {
  const [status, setStatus] = useState<ReadinessStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const refresh = () => {
      setNow(Date.now());
      void api<ReadinessStatus | null>("/api/setup/searchstax/status")
        .then((value) => {
          if (!stopped) setStatus(value);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 250);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [active]);
  return { status: active ? status : null, now, clear: () => setStatus(null) };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body
      ? { "content-type": "application/json", ...init.headers }
      : init?.headers,
  });
  const result = (await response.json()) as T & ApiFailure;
  if (!response.ok) throw new Error(apiFailureMessage(result));
  return result;
}

const initialFields = {
  accountSubdomain: "",
  email: "",
  apiToken: "",
  brandId: "",
  connectorKey: "",
  updateEndpoint: "",
  selectEndpoint: "",
  token: "",
  destinationName: "",
  previewUrl: "",
};

type Fields = typeof initialFields;

export function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="notice error" role="alert">
      <strong>Couldn’t continue.</strong> {message}
    </div>
  );
}

export function LocaleChoices({
  choices,
  selected,
  onChange,
}: {
  choices: ZendeskValidation["locales"];
  selected: readonly string[];
  onChange: (locales: string[]) => void;
}) {
  return (
    <div className="locale-list">
      {choices.map((locale) => (
        <label
          className={!locale.supported ? "unsupported" : ""}
          key={locale.locale}
        >
          <input
            type="checkbox"
            disabled={!locale.supported}
            checked={selected.includes(locale.locale)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, locale.locale]
                  : selected.filter((item) => item !== locale.locale),
              )
            }
          />{" "}
          <span>
            {locale.locale}
            {locale.reason && <small>{locale.reason}</small>}
          </span>
        </label>
      ))}
    </div>
  );
}

export function RecoveryConfirmation({
  plan,
  confirmation,
  busy,
  onConfirmation,
  onBack,
  onApply,
}: {
  plan: NamespaceRecoveryPlan;
  confirmation: string;
  busy: boolean;
  onConfirmation: (value: string) => void;
  onBack: () => void;
  onApply: () => void;
}) {
  return (
    <div>
      <p className="eyebrow">Local state recovery</p>
      <h2 id="setup-heading">Confirm existing namespace adoption</h2>
      <p>
        Source fields and all {plan.recordCount} connector-owned destination IDs
        match. This rebuilds local ownership only; it does not write or delete
        destination records.
      </p>
      <code>{plan.fingerprint}</code>
      <label>
        Namespace-recovery fingerprint
        <input
          value={confirmation}
          onChange={(event) => onConfirmation(event.target.value)}
        />
      </label>
      <div className="actions">
        <button className="secondary" onClick={onBack}>
          Back
        </button>
        <button
          className="primary"
          disabled={busy || confirmation !== plan.fingerprint}
          onClick={onApply}
        >
          {busy ? "Rechecking…" : "Adopt exact namespace"}
        </button>
      </div>
    </div>
  );
}

export function SetupWizard({
  onComplete,
}: {
  onComplete: (setup: SafeSetup) => void;
}) {
  const [fields, setFields] = useState<Fields>(initialFields);
  const [step, setStep] = useState(1);
  const [oauthAvailable, setOauthAvailable] = useState(false);
  const [oauthHandle, setOauthHandle] = useState("");
  const [legacy, setLegacy] = useState(true);
  useEffect(() => {
    void api<SafeSetup>("/api/setup")
      .then((value) => {
        setOauthAvailable(!!value.oauthAvailable);
        setLegacy(!value.oauthAvailable);
      })
      .catch(() => undefined);
    void api<{ handle: string; accountSubdomain: string } | null>(
      "/api/oauth/zendesk/candidate",
    )
      .then((value) => {
        if (
          value &&
          typeof value.handle === "string" &&
          typeof value.accountSubdomain === "string"
        ) {
          setOauthHandle(value.handle);
          setFields((current) => ({
            ...current,
            accountSubdomain: value.accountSubdomain,
          }));
          setLegacy(false);
        }
      })
      .catch(() => undefined);
    history.replaceState(null, "", location.pathname);
  }, []);
  const [discovery, setDiscovery] = useState<ZendeskValidation>({
    brands: [],
    locales: [],
  });
  const [locales, setLocales] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() =>
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("zendesk_oauth") === "failed"
      ? "Zendesk connection was not completed. Check the private connection and try again."
      : "",
  );
  const [recoveryPlan, setRecoveryPlan] =
    useState<NamespaceRecoveryPlan | null>(null);
  const [recoveryConfirmation, setRecoveryConfirmation] = useState("");

  const update = (name: keyof Fields, value: string) =>
    setFields((current) => ({ ...current, [name]: value }));

  async function submit(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The request failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const zendeskBody = () => ({
    accountSubdomain: fields.accountSubdomain,
    email: fields.email,
    apiToken: fields.apiToken,
    ...(!legacy && oauthHandle ? { oauthHandle } : {}),
    ...(fields.brandId ? { brandId: fields.brandId } : {}),
  });

  const validateZendesk = (event: FormEvent) => {
    event.preventDefault();
    void submit(async () => {
      const result = await api<ZendeskValidation>(
        "/api/setup/zendesk/validate",
        {
          method: "POST",
          body: JSON.stringify(zendeskBody()),
        },
      );
      setDiscovery(result);
      setStep(2);
    });
  };

  const discoverBrandLocales = () =>
    submit(async () => {
      const result = await api<ZendeskValidation>(
        "/api/setup/zendesk/validate",
        {
          method: "POST",
          body: JSON.stringify(zendeskBody()),
        },
      );
      setDiscovery(result);
      setLocales(
        result.locales
          .filter((locale) => locale.supported)
          .map((locale) => locale.locale),
      );
      setStep(3);
    });

  const validateDestination = (event: FormEvent) => {
    event.preventDefault();
    void submit(async () => {
      await api("/api/setup/searchstax/validate", {
        method: "POST",
        body: JSON.stringify({
          connectorKey: fields.connectorKey,
          updateEndpoint: fields.updateEndpoint,
          selectEndpoint: fields.selectEndpoint,
          token: fields.token,
        }),
      });
      setStep(4);
    });
  };

  const complete = () =>
    submit(async () => {
      const setup = await api<SafeSetup>("/api/setup/complete", {
        method: "POST",
        body: JSON.stringify({
          ...fields,
          locales,
          ...(!legacy && oauthHandle ? { oauthHandle } : {}),
        }),
      });
      setFields(initialFields);
      onComplete(setup);
    });

  const planRecovery = () =>
    submit(async () => {
      const plan = await api<NamespaceRecoveryPlan>("/api/recovery/plan", {
        method: "POST",
        body: JSON.stringify({
          ...fields,
          locales,
          ...(!legacy && oauthHandle ? { oauthHandle } : {}),
        }),
      });
      setRecoveryPlan(plan);
      setRecoveryConfirmation("");
      setStep(4);
    });

  const applyRecovery = () =>
    submit(async () => {
      const setup = await api<SafeSetup>("/api/recovery/apply", {
        method: "POST",
        body: JSON.stringify({
          ...fields,
          ...(!legacy && oauthHandle ? { oauthHandle } : {}),
          locales,
          fingerprint: recoveryConfirmation,
        }),
      });
      setFields(initialFields);
      onComplete(setup);
    });

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Private operator tool</p>
          <h1>Connect Zendesk to SearchStax</h1>
        </div>
        <span className="status-pill">Setup · Step {step} of 4</span>
      </header>
      <div className="setup-layout">
        <nav aria-label="Setup progress" className="step-list">
          {["Zendesk access", "Brand", "Destination", "Review"].map(
            (label, index) => (
              <span
                aria-current={step === index + 1 ? "step" : undefined}
                className={step >= index + 1 ? "current" : ""}
                key={label}
              >
                <b>{index + 1}</b> {label}
              </span>
            ),
          )}
        </nav>
        <section className="panel" aria-labelledby="setup-heading">
          {error && <ErrorMessage message={error} />}
          {step === 1 && (
            <form onSubmit={validateZendesk}>
              <p className="eyebrow">Zendesk access</p>
              <h2 id="setup-heading">Validate the service account</h2>
              <p className="muted">
                Credentials are encrypted when saved and are never displayed
                again.
              </p>
              <p className="muted">
                Public help centers only. Maximum 500 article translations
                across selected locales. OAuth does not preserve search
                permissions.
              </p>
              {oauthAvailable && (
                <label>
                  <input
                    type="checkbox"
                    checked={legacy}
                    onChange={(event) => {
                      void api("/api/oauth/zendesk/cancel", {
                        method: "POST",
                        body: "{}",
                      }).catch(() => undefined);
                      setLegacy(event.target.checked);
                      setOauthHandle("");
                    }}
                  />{" "}
                  Use existing legacy API token temporarily
                </label>
              )}
              {legacy && (
                <p className="muted">
                  Legacy API tokens stop working by April 30, 2027; newer
                  accounts cannot use them. OAuth requires installation
                  configuration.
                </p>
              )}
              <div className="form-grid">
                <label>
                  Account subdomain
                  <input
                    autoFocus
                    required
                    value={fields.accountSubdomain}
                    onChange={(event) => {
                      update("accountSubdomain", event.target.value);
                      setOauthHandle("");
                    }}
                    placeholder="company"
                  />
                </label>
                {legacy && (
                  <>
                    <label>
                      Service-account email
                      <input
                        required
                        type="email"
                        value={fields.email}
                        onChange={(event) =>
                          update("email", event.target.value)
                        }
                      />
                    </label>
                    <label className="wide">
                      Zendesk API token
                      <input
                        required
                        type="password"
                        autoComplete="off"
                        value={fields.apiToken}
                        onChange={(event) =>
                          update("apiToken", event.target.value)
                        }
                      />
                    </label>
                  </>
                )}
              </div>
              {!legacy && !oauthHandle && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !fields.accountSubdomain}
                  onClick={() =>
                    void submit(async () => {
                      const result = await api<{ authorizationUrl: string }>(
                        "/api/oauth/zendesk/start",
                        {
                          method: "POST",
                          body: JSON.stringify({
                            accountSubdomain: fields.accountSubdomain,
                          }),
                        },
                      );
                      location.assign(result.authorizationUrl);
                    })
                  }
                >
                  Connect to Zendesk
                </button>
              )}
              {oauthHandle && !legacy && (
                <p>
                  Zendesk authorization received. Validate access to choose a
                  brand.
                </p>
              )}
              <button
                className="primary"
                disabled={busy || (!legacy && !oauthHandle)}
              >
                {busy ? "Validating…" : "Validate Zendesk"}
              </button>
            </form>
          )}
          {step === 2 && (
            <div>
              <p className="eyebrow">Help Center brand</p>
              <h2 id="setup-heading">Choose one brand</h2>
              <label>
                Accessible brand
                <select
                  autoFocus
                  required
                  value={fields.brandId}
                  onChange={(event) => update("brandId", event.target.value)}
                >
                  <option value="">Select a brand</option>
                  {discovery.brands.map((brand) => (
                    <option value={brand.id} key={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="actions">
                <button className="secondary" onClick={() => setStep(1)}>
                  Back
                </button>
                <button
                  className="primary"
                  disabled={!fields.brandId || busy}
                  onClick={() => void discoverBrandLocales()}
                >
                  {busy ? "Checking…" : "Discover locales"}
                </button>
              </div>
            </div>
          )}
          {step === 3 && (
            <form onSubmit={validateDestination}>
              <p className="eyebrow">Locales and destination</p>
              <h2 id="setup-heading">Connect SearchStax</h2>
              <p>
                We’ll check your connection now. After you save, we’ll finish
                checking the index in the background.
              </p>
              <fieldset>
                <legend>Locales to index</legend>
                <LocaleChoices
                  choices={discovery.locales}
                  selected={locales}
                  onChange={setLocales}
                />
              </fieldset>
              <div className="form-grid">
                <label>
                  Connector key
                  <input
                    required
                    pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
                    value={fields.connectorKey}
                    onChange={(event) =>
                      update("connectorKey", event.target.value)
                    }
                  />
                </label>
                <label>
                  Destination name
                  <input
                    required
                    value={fields.destinationName}
                    onChange={(event) =>
                      update("destinationName", event.target.value)
                    }
                  />
                </label>
                <label className="wide">
                  Update endpoint
                  <input
                    required
                    type="url"
                    value={fields.updateEndpoint}
                    onChange={(event) =>
                      update("updateEndpoint", event.target.value)
                    }
                  />
                </label>
                <label className="wide">
                  Search endpoint (/emselect or /select)
                  <input
                    required
                    type="url"
                    value={fields.selectEndpoint}
                    onChange={(event) =>
                      update("selectEndpoint", event.target.value)
                    }
                  />
                </label>
                <label className="wide">
                  Read &amp; Write token
                  <input
                    required
                    type="password"
                    autoComplete="off"
                    value={fields.token}
                    onChange={(event) => update("token", event.target.value)}
                  />
                </label>
                <label className="wide">
                  Preview URL <span className="optional">Optional</span>
                  <input
                    type="url"
                    value={fields.previewUrl}
                    onChange={(event) =>
                      update("previewUrl", event.target.value)
                    }
                  />
                </label>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setStep(2)}
                >
                  Back
                </button>
                <button className="primary" disabled={!locales.length || busy}>
                  {busy ? "Checking connection…" : "Check connection"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!locales.length || busy}
                  onClick={() => void planRecovery()}
                >
                  Plan namespace recovery
                </button>
              </div>
            </form>
          )}
          {step === 4 && recoveryPlan && (
            <RecoveryConfirmation
              plan={recoveryPlan}
              confirmation={recoveryConfirmation}
              busy={busy}
              onConfirmation={setRecoveryConfirmation}
              onBack={() => {
                setRecoveryPlan(null);
                setStep(3);
              }}
              onApply={() => void applyRecovery()}
            />
          )}
          {step === 4 && !recoveryPlan && (
            <div>
              <p className="eyebrow">Review</p>
              <h2 id="setup-heading">Ready to save</h2>
              <dl className="review-list">
                <div>
                  <dt>Brand</dt>
                  <dd>
                    {
                      discovery.brands.find(
                        (brand) => brand.id === fields.brandId,
                      )?.name
                    }
                  </dd>
                </div>
                <div>
                  <dt>Locales</dt>
                  <dd>{locales.join(", ")}</dd>
                </div>
                <div>
                  <dt>Destination</dt>
                  <dd>{fields.destinationName}</dd>
                </div>
                <div>
                  <dt>Credentials</dt>
                  <dd>
                    Read access checked · write access checked after saving
                  </dd>
                </div>
              </dl>
              <div className="notice">
                Completing setup stores encrypted credentials. Source identity
                and connector key lock after the first successful sync.
              </div>
              <div className="actions">
                <button className="secondary" onClick={() => setStep(3)}>
                  Back
                </button>
                <button
                  autoFocus
                  className="primary"
                  disabled={busy}
                  onClick={() => void complete()}
                >
                  {busy ? "Saving…" : "Complete setup"}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

const terminal = new Set([
  "succeeded",
  "completed_with_errors",
  "degraded",
  "canceled",
  "failed",
  "abandoned",
]);

function issueReason(code: string) {
  if (code === "RECORD_TOO_LARGE")
    return "Record exceeds the destination request limit.";
  if (code === "HIERARCHY_UNAVAILABLE")
    return "Article hierarchy could not be read.";
  if (code === "INVALID_HIERARCHY")
    return "Article hierarchy is incomplete or inconsistent.";
  return "Article data could not be safely indexed.";
}

function schedulerStatus(scheduler: SafeScheduler) {
  return scheduler.state === "enabled" && scheduler.retryAttempt > 0
    ? "retrying"
    : scheduler.state;
}

function schedulerReason(reason: SafeScheduler["pauseReason"]) {
  return reason?.replaceAll("_", " ");
}

function RunStatus({ run }: { run: SafeRun }) {
  return (
    <div className={`run-status state-${run.state}`}>
      <div>
        <p className="eyebrow">Current run</p>
        <h2>{run.state.replaceAll("_", " ")}</h2>
      </div>
      <dl className="metric-row">
        <div>
          <dt>Found</dt>
          <dd>{run.counts.source}</dd>
        </div>
        <div>
          <dt>New</dt>
          <dd>{run.counts.created}</dd>
        </div>
        <div>
          <dt>Changed</dt>
          <dd>{run.counts.changed}</dd>
        </div>
        <div>
          <dt>Unchanged</dt>
          <dd>{run.counts.unchanged}</dd>
        </div>
        <div>
          <dt>Stale</dt>
          <dd>{run.counts.stale}</dd>
        </div>
        <div>
          <dt>Deleted</dt>
          <dd>{run.counts.successfulDeletions}</dd>
        </div>
        <div>
          <dt>Deletion errors</dt>
          <dd>{run.counts.failedDeletions}</dd>
        </div>
        <div>
          <dt>Withheld</dt>
          <dd>{run.counts.withheldDeletions}</dd>
        </div>
        <div>
          <dt>Quarantined</dt>
          <dd>{run.counts.quarantined}</dd>
        </div>
      </dl>
      {run.failureCode && (
        <div className="notice error" role="alert">
          Run stopped safely: {run.failureCode}
        </div>
      )}
    </div>
  );
}

export function DashboardView({
  dashboard,
  runs,
  refresh,
  notificationsEnabled = false,
  onNotificationsChange = async () => undefined,
}: {
  dashboard: Dashboard;
  runs: SafeRun[];
  refresh: () => Promise<void>;
  notificationsEnabled?: boolean;
  onNotificationsChange?: () => Promise<void>;
}) {
  const [oauthCandidate, setOauthCandidate] = useState<{
    handle: string;
    accountSubdomain: string;
  } | null>(null);
  useEffect(() => {
    void api<{ handle: string; accountSubdomain: string } | null>(
      "/api/oauth/zendesk/candidate",
    )
      .then((value) =>
        setOauthCandidate(
          value &&
            typeof value.handle === "string" &&
            typeof value.accountSubdomain === "string"
            ? value
            : null,
        ),
      )
      .catch(() => undefined);
    history.replaceState(null, "", location.pathname);
  }, []);
  const [busy, setBusy] = useState(false);
  const [readinessBusy, setReadinessBusy] = useState(false);
  const [error, setError] = useState(() =>
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("zendesk_oauth") === "failed"
      ? "Zendesk connection was not completed. Check the private connection and try again."
      : "",
  );
  const [confirmation, setConfirmation] = useState("");
  const [localeInput, setLocaleInput] = useState(
    dashboard.setup.locales?.join(", ") ?? "",
  );
  const [localePlan, setLocalePlan] = useState<LocalePlan | null>(null);
  const [dryRun, setDryRun] = useState<ExistingIndexDryRun | null>(null);
  const [applyResult, setApplyResult] =
    useState<ExistingIndexApplyResult | null>(null);
  const [legacyIngestionPaused, setLegacyIngestionPaused] = useState(false);
  const [zendeskCredentials, setZendeskCredentials] = useState({
    accountSubdomain: "",
    email: "",
    apiToken: "",
  });
  const [searchstaxCredentials, setSearchstaxCredentials] = useState({
    updateEndpoint: "",
    selectEndpoint: "",
    token: "",
  });
  const active = dashboard.activeRun;
  const scheduleStatus = schedulerStatus(dashboard.scheduler);
  const readiness = useReadinessProgress(
    readinessBusy || dashboard.setup.state === "destination_validated",
  );

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The request failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function readinessAct(action: () => Promise<unknown>) {
    readiness.clear();
    setReadinessBusy(true);
    try {
      await act(action);
    } finally {
      setReadinessBusy(false);
    }
  }

  const replaceZendesk = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await api("/api/credentials/zendesk", {
        method: "PUT",
        body: JSON.stringify(zendeskCredentials),
      });
      setZendeskCredentials({ accountSubdomain: "", email: "", apiToken: "" });
    });
  };

  const replaceSearchStax = (event: FormEvent) => {
    event.preventDefault();
    void readinessAct(async () => {
      await api("/api/credentials/searchstax", {
        method: "PUT",
        body: JSON.stringify(searchstaxCredentials),
      });
      setSearchstaxCredentials({
        updateEndpoint: "",
        selectEndpoint: "",
        token: "",
      });
    });
  };

  const runExistingIndexDryRun = () =>
    void act(async () => {
      setDryRun(
        await api<ExistingIndexDryRun>("/api/existing-index/dry-run", {
          method: "POST",
          body: "{}",
        }),
      );
      setApplyResult(null);
      setLegacyIngestionPaused(false);
    });

  const applyExistingIndex = () =>
    void act(async () => {
      const result = await api<ExistingIndexApplyResult>(
        "/api/existing-index/apply",
        {
          method: "POST",
          body: JSON.stringify({
            fingerprint: dryRun?.fingerprint,
            legacyIngestionPaused,
          }),
        },
      );
      setApplyResult(result);
      if (result.status === "rejected")
        throw new Error(
          result.message ?? "The reviewed plan is stale. Run a new dry run.",
        );
      if (result.status === "applied") {
        setDryRun(null);
        setLegacyIngestionPaused(false);
      }
    });

  if (
    !["ready", "locked_after_first_success"].includes(dashboard.setup.state)
  ) {
    const pending = dashboard.setup.state === "destination_validated";
    return (
      <main className="app-shell dashboard">
        <header className="topbar">
          <h1>
            {pending
              ? "Your connection is saved"
              : "Your index needs attention"}
          </h1>
        </header>
        <section className="panel" aria-labelledby="setup-status-heading">
          <h2 id="setup-status-heading">
            {pending
              ? "Checking your search index"
              : "We couldn’t finish the index check"}
          </h2>
          <p>
            {pending
              ? "SearchStax can take several minutes to make new documents searchable. We’re checking write access and index compatibility in the background. You can leave this page and come back. Keep the connector running."
              : "Your credentials are saved, but indexing or cleanup wasn’t confirmed. Retry the check. If it fails again, check your endpoints and Read & Write token below."}
          </p>
          <p>
            Syncing will be available when these checks finish. Hourly
            scheduling stays off until you enable it.
          </p>
          {error && <ErrorMessage message={error} />}
          {pending && readiness.status && (
            <ReadinessProgress
              background
              status={readiness.status}
              now={readiness.now}
            />
          )}
          {!pending && (
            <>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api("/api/setup/retry", { method: "POST", body: "{}" }),
                  )
                }
              >
                {busy ? "Retrying…" : "Retry index check"}
              </button>
              <details>
                <summary>Edit SearchStax connection</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                      await api("/api/setup/retry", {
                        method: "POST",
                        body: JSON.stringify(searchstaxCredentials),
                      });
                      setSearchstaxCredentials({
                        updateEndpoint: "",
                        selectEndpoint: "",
                        token: "",
                      });
                    });
                  }}
                >
                  <label>
                    Update endpoint
                    <input
                      required
                      type="url"
                      value={searchstaxCredentials.updateEndpoint}
                      onChange={(event) =>
                        setSearchstaxCredentials((current) => ({
                          ...current,
                          updateEndpoint: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Search endpoint (/emselect or /select)
                    <input
                      required
                      type="url"
                      value={searchstaxCredentials.selectEndpoint}
                      onChange={(event) =>
                        setSearchstaxCredentials((current) => ({
                          ...current,
                          selectEndpoint: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Read &amp; Write token
                    <input
                      required
                      type="password"
                      autoComplete="off"
                      value={searchstaxCredentials.token}
                      onChange={(event) =>
                        setSearchstaxCredentials((current) => ({
                          ...current,
                          token: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <button className="primary" disabled={busy}>
                    {busy ? "Checking connection…" : "Save and retry"}
                  </button>
                </form>
              </details>
            </>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell dashboard">
      <header className="topbar">
        <div>
          <p className="eyebrow">Zendesk Connector</p>
          <h1>Operations</h1>
        </div>
        <span className={`status-pill scheduler-${scheduleStatus}`}>
          {scheduleStatus}
        </span>
      </header>
      {error && <ErrorMessage message={error} />}
      {readiness.status && (
        <ReadinessProgress status={readiness.status} now={readiness.now} />
      )}
      <section
        className="panel scheduler-panel"
        aria-labelledby="scheduler-heading"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">Scheduling</p>
            <h2 id="scheduler-heading">Hourly reconciliation</h2>
          </div>
          <span
            className={`status-pill scheduler-${scheduleStatus}`}
            aria-label={`Scheduling status: ${scheduleStatus}`}
          >
            {scheduleStatus}
          </span>
        </div>
        <p className="muted">
          Automatic full syncs run hourly while this local app is running.
        </p>
        <dl className="compact-list scheduler-details">
          <div>
            <dt>Status</dt>
            <dd>{scheduleStatus}</dd>
          </div>
          {dashboard.scheduler.nextRunAt && (
            <div>
              <dt>Next run</dt>
              <dd>
                {new Date(dashboard.scheduler.nextRunAt).toLocaleString()}
              </dd>
            </div>
          )}
          {dashboard.scheduler.retryAttempt > 0 && (
            <div>
              <dt>Retry attempt</dt>
              <dd>{dashboard.scheduler.retryAttempt} of 2</dd>
            </div>
          )}
          {dashboard.scheduler.pauseReason && (
            <div>
              <dt>Pause reason</dt>
              <dd>{schedulerReason(dashboard.scheduler.pauseReason)}</dd>
            </div>
          )}
        </dl>
        <div className="actions scheduler-actions">
          {dashboard.scheduler.state === "enabled" ? (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api("/api/scheduler", {
                    method: "PUT",
                    body: JSON.stringify({ enabled: false }),
                  }),
                )
              }
            >
              Pause scheduling
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api("/api/scheduler", {
                    method: "PUT",
                    body: JSON.stringify({ enabled: true }),
                  }),
                )
              }
            >
              Enable scheduling
            </button>
          )}
        </div>
      </section>
      <section className="hero panel">
        <div>
          <p className="eyebrow">Readiness</p>
          <h2>{dashboard.setup.brand?.name}</h2>
          <p className="muted">
            {dashboard.setup.locales?.join(" · ")} →{" "}
            {dashboard.setup.destinationName}
          </p>
        </div>
        {!active && (
          <button
            className="primary large"
            disabled={busy}
            onClick={() =>
              void act(() => api("/api/runs", { method: "POST", body: "{}" }))
            }
          >
            Sync now
          </button>
        )}
        {active &&
          !terminal.has(active.state) &&
          !["guarded", "action_required"].includes(active.state) && (
            <button
              className="secondary danger"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(`/api/runs/${encodeURIComponent(active.id)}/cancel`, {
                    method: "POST",
                    body: "{}",
                  }),
                )
              }
            >
              Cancel run
            </button>
          )}
      </section>
      <section className="panel" aria-labelledby="existing-index-heading">
        <p className="eyebrow">Existing-index review</p>
        <h2 id="existing-index-heading">Read-only dry run</h2>
        <p className="muted">
          Inspect current Zendesk sources and plausible existing SearchStax
          records. This never writes, deletes, adopts, or changes scheduling.
        </p>
        <button
          className="secondary"
          disabled={busy}
          onClick={runExistingIndexDryRun}
        >
          Run existing-index dry run
        </button>
        {dryRun && (
          <div className="details-body">
            <dl className="metric-row">
              <div>
                <dt>Sources</dt>
                <dd>{dryRun.counts.sourceIdentities}</dd>
              </div>
              <div>
                <dt>Candidates</dt>
                <dd>{dryRun.counts.candidates}</dd>
              </div>
              <div>
                <dt>Managed</dt>
                <dd>{dryRun.counts.managed}</dd>
              </div>
              <div>
                <dt>Adopt</dt>
                <dd>{dryRun.counts.adopt}</dd>
              </div>
              <div>
                <dt>Consolidate</dt>
                <dd>{dryRun.counts.consolidate}</dd>
              </div>
              <div>
                <dt>Create</dt>
                <dd>{dryRun.counts.create}</dd>
              </div>
              <div>
                <dt>Ambiguous / unmatched</dt>
                <dd>{dryRun.counts.ambiguousUnmatched}</dd>
              </div>
            </dl>
            <p className="muted small">
              URL fields:{" "}
              {Object.entries(dryRun.fieldAvailability)
                .map(([field, status]) => `${field} ${status.state}`)
                .join(" · ")}
            </p>
            <p className="muted small">Review fingerprint</p>
            <code>{dryRun.fingerprint}</code>
            <ul className="compact-list">
              {dryRun.actions.map((action, index) => (
                <li
                  key={`${action.classification}-${action.candidateDestinationIds.join(",")}-${index}`}
                >
                  <strong>{action.classification}</strong>{" "}
                  {action.sourceIdentity
                    ? `${action.sourceIdentity.subdomain} / ${action.sourceIdentity.articleId} / ${action.sourceIdentity.locale}`
                    : (action.reasonCode ??
                      "Candidate could not be matched safely.")}
                  {action.proposedDestinationId && (
                    <span className="muted">
                      {" "}
                      · proposed {action.proposedDestinationId}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="muted small">
              Apply mutates SearchStax and connector ownership. The old crawler
              or any legacy ingestion process that can recreate these records
              must be paused or disabled first; the connector does not control
              that process.
            </p>
            <label>
              <input
                type="checkbox"
                checked={legacyIngestionPaused}
                onChange={(event) =>
                  setLegacyIngestionPaused(event.target.checked)
                }
              />{" "}
              I confirm legacy ingestion is paused or disabled.
            </label>
            <button
              className="danger primary"
              disabled={busy || !legacyIngestionPaused}
              onClick={applyExistingIndex}
            >
              Apply reviewed dry run
            </button>
          </div>
        )}
      </section>
      {applyResult && (
        <section className="panel" aria-labelledby="existing-index-result">
          <p className="eyebrow">Existing-index apply</p>
          <h2 id="existing-index-result">{applyResult.status}</h2>
          <dl className="metric-row">
            <div>
              <dt>Managed</dt>
              <dd>{applyResult.counts.managed}</dd>
            </div>
            <div>
              <dt>Adopted</dt>
              <dd>{applyResult.counts.adopted}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{applyResult.counts.created}</dd>
            </div>
            <div>
              <dt>Consolidated</dt>
              <dd>{applyResult.counts.consolidated}</dd>
            </div>
            <div>
              <dt>Redundant deleted</dt>
              <dd>{applyResult.counts.redundantDeleted}</dd>
            </div>
            <div>
              <dt>Unresolved</dt>
              <dd>{applyResult.counts.unresolvedResiduals}</dd>
            </div>
          </dl>
          {applyResult.message && <p>{applyResult.message}</p>}
          {applyResult.unresolvedResiduals.length > 0 && (
            <p className="muted small">
              Remaining reviewed residuals:{" "}
              {applyResult.unresolvedResiduals.join(", ")}
            </p>
          )}
        </section>
      )}
      {active && <RunStatus run={active} />}
      {active &&
        ["guarded", "action_required"].includes(active.state) &&
        active.deletionPlan && (
          <section className="panel guarded" aria-labelledby="guard-heading">
            <p className="eyebrow">Manual confirmation required</p>
            <h2 id="guard-heading">
              Review {active.deletionPlan.staleCount} stale records
            </h2>
            <p>
              Deletion is paused. Paste the exact fingerprint to confirm this
              unchanged plan.
            </p>
            <p className="muted small">
              Destination IDs: {active.deletionPlan.exactIds.join(", ")}
            </p>
            <code>{active.deletionPlan.fingerprint}</code>
            <label>
              Deletion-plan fingerprint
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <button
              className="danger primary"
              disabled={
                busy || confirmation !== active.deletionPlan.fingerprint
              }
              onClick={() =>
                void act(() =>
                  api(
                    `/api/deletion-plans/${encodeURIComponent(active.deletionPlan!.id)}/confirm`,
                    {
                      method: "POST",
                      body: JSON.stringify({ fingerprint: confirmation }),
                    },
                  ),
                )
              }
            >
              Confirm exact deletion plan
            </button>
          </section>
        )}
      {dashboard.issues.length > 0 && (
        <section className="panel issues" aria-labelledby="issues-heading">
          <p className="eyebrow">Needs attention</p>
          <h2 id="issues-heading">Quarantined articles</h2>
          <ul className="compact-list">
            {dashboard.issues.map((issue) => (
              <li
                key={`${issue.articleId}:${issue.locale}:${issue.reasonCode}`}
              >
                <a href={issue.publicUrl} target="_blank" rel="noreferrer">
                  {issue.publicTitle}
                </a>{" "}
                <span className="muted">({issue.locale})</span>
                <p>{issueReason(issue.reasonCode)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="panel incidents" aria-labelledby="incidents-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Incidents</p>
            <h2 id="incidents-heading">Recent incidents</h2>
          </div>
          <button
            className="secondary"
            onClick={() => void onNotificationsChange()}
          >
            {notificationsEnabled
              ? "Disable browser alerts"
              : "Enable browser alerts"}
          </button>
        </div>
        {dashboard.incidents.length ? (
          <ul className="compact-list">
            {dashboard.incidents.map((incident) => (
              <li key={incident.key}>
                <strong>{incidentReason(incident.event)}</strong>{" "}
                <span className="muted">
                  {new Date(incident.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No recent incidents.</p>
        )}
      </section>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Current corpus</p>
              <h2>Records by locale</h2>
            </div>
            {dashboard.setup.previewUrl && (
              <a
                className="text-link"
                href={dashboard.setup.previewUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open SearchStax Preview <span aria-hidden="true">↗</span>
              </a>
            )}
          </div>
          {dashboard.manifestCounts.length ? (
            <dl className="locale-counts">
              {dashboard.manifestCounts.map((item) => (
                <div key={item.locale}>
                  <dt>{item.locale}</dt>
                  <dd>{item.count}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="empty">
              No acknowledged records yet. Start the first sync when you’re
              ready.
            </p>
          )}
        </section>
        <section className="panel">
          <p className="eyebrow">Configuration</p>
          <h2>Protected and ready</h2>
          <dl className="compact-list">
            <div>
              <dt>Zendesk credentials</dt>
              <dd>Configured · write-only</dd>
            </div>
            <div>
              <dt>SearchStax credentials</dt>
              <dd>Configured · write-only</dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd>{dashboard.setup.revision}</dd>
            </div>
          </dl>
          <details>
            <summary>Change locale selection</summary>
            <div className="details-body">
              <label>
                Zendesk locales, separated by commas
                <input
                  value={localeInput}
                  onChange={(event) => {
                    setLocaleInput(event.target.value);
                    setLocalePlan(null);
                  }}
                />
              </label>
              <p className="muted small">
                The connector revalidates compatibility before creating an exact
                plan.
              </p>
              {!localePlan ? (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const plan = await api<LocalePlan>("/api/locales/plan", {
                        method: "POST",
                        body: JSON.stringify({
                          locales: localeInput
                            .split(",")
                            .map((locale) => locale.trim())
                            .filter(Boolean),
                        }),
                      });
                      setLocalePlan(plan);
                    })
                  }
                >
                  Preview locale plan
                </button>
              ) : (
                <div className="notice">
                  <strong>{localePlan.removedRecordCount} records</strong> would
                  become stale on the next complete sync.
                  <code>{localePlan.fingerprint}</code>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api("/api/locales/apply", {
                          method: "POST",
                          body: JSON.stringify({
                            planId: localePlan.id,
                            fingerprint: localePlan.fingerprint,
                          }),
                        });
                        setLocalePlan(null);
                      })
                    }
                  >
                    Apply unchanged plan
                  </button>
                </div>
              )}
            </div>
          </details>
          <details open={Boolean(oauthCandidate)}>
            <summary>Replace Zendesk credentials</summary>
            {dashboard.setup.oauthAvailable && (
              <div className="details-body">
                <p>
                  Zendesk authentication:{" "}
                  {dashboard.setup.zendeskAuth ?? "legacy"}. Reconnect preserves
                  the configured account, brand and index. Resume scheduling
                  explicitly after an authentication pause.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const result = await api<{ authorizationUrl: string }>(
                        "/api/oauth/zendesk/start",
                        {
                          method: "POST",
                          body: JSON.stringify({
                            accountSubdomain: dashboard.setup.zendeskAccount,
                          }),
                        },
                      );
                      location.assign(result.authorizationUrl);
                    })
                  }
                >
                  Reconnect Zendesk with OAuth
                </button>
                {oauthCandidate && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api("/api/credentials/zendesk", {
                          method: "PUT",
                          body: JSON.stringify({
                            accountSubdomain: oauthCandidate.accountSubdomain,
                            oauthHandle: oauthCandidate.handle,
                          }),
                        });
                        setOauthCandidate(null);
                      })
                    }
                  >
                    Validate and save Zendesk authorization
                  </button>
                )}
              </div>
            )}
            <form className="details-body" onSubmit={replaceZendesk}>
              <label>
                Account subdomain
                <input
                  required
                  value={zendeskCredentials.accountSubdomain}
                  onChange={(event) =>
                    setZendeskCredentials((value) => ({
                      ...value,
                      accountSubdomain: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Service-account email
                <input
                  required
                  type="email"
                  value={zendeskCredentials.email}
                  onChange={(event) =>
                    setZendeskCredentials((value) => ({
                      ...value,
                      email: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                New Zendesk API token
                <input
                  required
                  type="password"
                  autoComplete="off"
                  value={zendeskCredentials.apiToken}
                  onChange={(event) =>
                    setZendeskCredentials((value) => ({
                      ...value,
                      apiToken: event.target.value,
                    }))
                  }
                />
              </label>
              <button className="secondary" disabled={busy}>
                Validate and replace
              </button>
            </form>
          </details>
          <details>
            <summary>Replace SearchStax credentials</summary>
            <form className="details-body" onSubmit={replaceSearchStax}>
              <ReadinessTimingNotice />
              <label>
                Update endpoint
                <input
                  required
                  type="url"
                  value={searchstaxCredentials.updateEndpoint}
                  onChange={(event) =>
                    setSearchstaxCredentials((value) => ({
                      ...value,
                      updateEndpoint: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Search endpoint (/emselect or /select)
                <input
                  required
                  type="url"
                  value={searchstaxCredentials.selectEndpoint}
                  onChange={(event) =>
                    setSearchstaxCredentials((value) => ({
                      ...value,
                      selectEndpoint: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                New Read &amp; Write token
                <input
                  required
                  type="password"
                  autoComplete="off"
                  value={searchstaxCredentials.token}
                  onChange={(event) =>
                    setSearchstaxCredentials((value) => ({
                      ...value,
                      token: event.target.value,
                    }))
                  }
                />
              </label>
              <button className="secondary" disabled={busy}>
                Run probe and replace
              </button>
            </form>
          </details>
        </section>
      </div>
      <section className="panel history">
        <p className="eyebrow">Run history</p>
        <h2>Latest activity</h2>
        {runs.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Found</th>
                  <th>New</th>
                  <th>Changed</th>
                  <th>Stale</th>
                  <th>Quarantined</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{new Date(run.startedAt).toLocaleString()}</td>
                    <td>
                      <span className={`inline-state state-${run.state}`}>
                        {run.state.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td>{run.counts.source}</td>
                    <td>{run.counts.created}</td>
                    <td>{run.counts.changed}</td>
                    <td>{run.counts.stale}</td>
                    <td>{run.counts.quarantined}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">No completed runs yet.</p>
        )}
      </section>
    </main>
  );
}

export function App() {
  const [setup, setSetup] = useState<SafeSetup | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [runs, setRuns] = useState<SafeRun[]>([]);
  const [error, setError] = useState(() =>
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("zendesk_oauth") === "failed"
      ? "Zendesk connection was not completed. Check the private connection and try again."
      : "",
  );
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () =>
      typeof window !== "undefined" &&
      "Notification" in window &&
      window.localStorage.getItem(notificationsEnabledKey) === "true" &&
      Notification.permission === "granted",
  );

  const refresh = useCallback(async () => {
    const [nextDashboard, history] = await Promise.all([
      api<Dashboard>("/api/dashboard"),
      api<{ runs: SafeRun[] }>("/api/runs"),
    ]);
    setDashboard(nextDashboard);
    setRuns(history.runs);
    notifyLatestIncident(nextDashboard.incidents);
  }, []);

  const changeNotifications = useCallback(async () => {
    if (notificationsEnabled) {
      window.localStorage.removeItem(notificationsEnabledKey);
      setNotificationsEnabled(false);
      return;
    }
    if (!("Notification" in window)) {
      setError("Browser notifications are unavailable.");
      return;
    }
    if ((await Notification.requestPermission()) !== "granted") return;
    window.localStorage.setItem(notificationsEnabledKey, "true");
    const latest = dashboard?.incidents[0];
    if (latest) window.localStorage.setItem(lastNotificationKey, latest.key);
    setNotificationsEnabled(true);
  }, [dashboard, notificationsEnabled]);

  useEffect(() => {
    void api<SafeSetup>("/api/setup")
      .then((value) => {
        setSetup(value);
        if (value.configured) return refresh();
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof Error
            ? caught.message
            : "The application could not load.",
        ),
      );
  }, [refresh]);
  useEffect(() => {
    if (
      !dashboard ||
      (dashboard.setup.state !== "destination_validated" &&
        dashboard.scheduler.state !== "enabled" &&
        (!dashboard.activeRun || terminal.has(dashboard.activeRun.state)))
    )
      return;
    const timer = window.setInterval(
      () =>
        void refresh().catch(() =>
          setError(
            "Couldn’t refresh setup progress. Reload this page to try again.",
          ),
        ),
      5000,
    );
    return () => window.clearInterval(timer);
  }, [dashboard, refresh]);

  if (error)
    return (
      <main className="centered">
        <ErrorMessage message={error} />
        <button className="primary" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </main>
    );
  if (!setup)
    return (
      <main className="centered" aria-live="polite">
        Loading connector…
      </main>
    );
  if (!setup.configured)
    return (
      <SetupWizard
        onComplete={(value) => {
          setSetup(value);
          void refresh();
        }}
      />
    );
  if (!dashboard)
    return (
      <main className="centered" aria-live="polite">
        Loading dashboard…
      </main>
    );
  return (
    <DashboardView
      dashboard={dashboard}
      runs={runs}
      refresh={refresh}
      notificationsEnabled={notificationsEnabled}
      onNotificationsChange={changeNotifications}
    />
  );
}
