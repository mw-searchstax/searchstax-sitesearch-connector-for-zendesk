export type ApiFailure = { error?: { code?: unknown; message?: unknown } };

const SAFE_API_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function apiFailureMessage(result: ApiFailure): string {
  const messages: Record<string, string> = {
    PERMANENT_HTTP_FAILURE:
      "Connection rejected. Check the endpoint and token, then try again.",
    TRANSIENT_HTTP_FAILURE:
      "The service is temporarily unavailable. Try again shortly.",
    REQUEST_TIMEOUT:
      "The connection timed out. Check the endpoint and try again.",
    FETCH_REJECTED:
      "Couldn’t reach the service. Check the endpoint and network connection, then try again.",
    INVALID_RESPONSE:
      "The endpoint returned an unexpected response. Check that you copied the correct endpoint, then try again.",
    REQUEST_DEADLINE:
      "The connection check took too long. Check the endpoint and try again.",
    READINESS_TIMEOUT: "The index hasn’t caught up yet. Retry the index check.",
    PROBE_CLEANUP_UNCERTAIN:
      "Index cleanup isn’t confirmed. Retry the index check before syncing.",
    SETUP_REQUIRED:
      "The index check must finish before syncing. View setup progress.",
  };
  if (typeof result.error?.code === "string" && messages[result.error.code])
    return messages[result.error.code];
  const message =
    typeof result.error?.message === "string" && result.error.message.trim()
      ? result.error.message.trim()
      : "The request could not be completed.";
  const code = result.error?.code;
  if (code === "INVALID_CONFIGURATION" || code === "INVALID_INPUT")
    return `${message} Correct the field and try again.`;
  return typeof code === "string" && SAFE_API_ERROR_CODE.test(code)
    ? `${message} Diagnostic code: ${code}.`
    : message;
}
