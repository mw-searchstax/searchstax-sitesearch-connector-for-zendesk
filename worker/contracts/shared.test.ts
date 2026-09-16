import { describe, expect, it, vi } from "vitest";

import { ContractError, requestWithRetry } from "./shared.ts";

function rejectingFetch(errors: readonly unknown[]) {
  let index = 0;
  const fetch = vi.fn(async () => {
    if (index >= errors.length) throw new Error("Unmatched network request");
    const error = errors[index++];
    throw error;
  });
  return fetch as unknown as typeof globalThis.fetch;
}

async function captureFailure(fetch: typeof globalThis.fetch) {
  try {
    await requestWithRetry(
      "https://example.com",
      {},
      { fetch, sleep: vi.fn(async () => undefined) },
      "Vendor",
    );
  } catch (error) {
    return error;
  }
  throw new Error("Expected requestWithRetry to reject");
}

describe("request retry diagnostics", () => {
  it("refuses redirects without following or exposing their target", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://private.example/redirect-target" },
        });
      },
    ) as unknown as typeof globalThis.fetch;

    const failure = await captureFailure(fetch);

    expect(failure).toMatchObject<Partial<ContractError>>({
      code: "REDIRECT_REFUSED",
      message: "Vendor redirect was refused.",
    });
    expect(String(failure)).not.toContain("private");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("classifies three timeout rejections without exposing exception details", async () => {
    const fetch = rejectingFetch([
      new DOMException("private first detail", "TimeoutError"),
      new DOMException("private second detail", "TimeoutError"),
      new DOMException("private third detail", "TimeoutError"),
    ]);

    const failure = await captureFailure(fetch);

    expect(failure).toMatchObject<Partial<ContractError>>({
      code: "REQUEST_TIMEOUT",
      message: "Vendor request timed out.",
    });
    expect(String(failure)).not.toContain("private");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("classifies three fetch rejections without exposing exception details", async () => {
    const fetch = rejectingFetch([
      new TypeError("private DNS detail"),
      new TypeError("private TLS detail"),
      new TypeError("private redirect detail"),
    ]);

    const failure = await captureFailure(fetch);

    expect(failure).toMatchObject<Partial<ContractError>>({
      code: "FETCH_REJECTED",
      message: "Vendor fetch was rejected.",
    });
    expect(String(failure)).not.toContain("private");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("classifies a mixed rejection sequence without exposing exception details", async () => {
    const fetch = rejectingFetch([
      new DOMException("private timeout detail", "TimeoutError"),
      new TypeError("private network detail"),
      new DOMException("private timeout detail", "TimeoutError"),
    ]);

    const failure = await captureFailure(fetch);

    expect(failure).toMatchObject<Partial<ContractError>>({
      code: "REQUEST_REJECTED_TFT",
      message: "Vendor request rejection sequence was classified.",
    });
    expect(String(failure)).not.toContain("private");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("classifies retryable responses mixed with terminal rejections", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("private network detail"))
      .mockRejectedValueOnce(
        new DOMException("private timeout detail", "TimeoutError"),
      ) as unknown as typeof globalThis.fetch;

    const failure = await captureFailure(fetch);

    expect(failure).toMatchObject<Partial<ContractError>>({
      code: "REQUEST_ATTEMPTS_RFT",
      message: "Vendor request attempt sequence was classified.",
    });
    expect(String(failure)).not.toContain("private");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("classifies other Error and DOMException rejections together", async () => {
    const fetch = rejectingFetch([
      new Error("private standard error detail"),
      new DOMException("private DOM detail", "NetworkError"),
      new TypeError("private fetch detail"),
    ]);

    const failure = await captureFailure(fetch);

    expect(failure).toMatchObject<Partial<ContractError>>({
      code: "REQUEST_REJECTED_EEF",
      message: "Vendor request rejection sequence was classified.",
    });
    expect(String(failure)).not.toContain("private");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("classifies other errors after the local deadline fires", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(AbortSignal.abort());
    const fetch = rejectingFetch([
      new Error("private first detail"),
      new Error("private second detail"),
      new Error("private third detail"),
    ]);

    const failure = await captureFailure(fetch);
    timeout.mockRestore();

    expect(failure).toMatchObject<Partial<ContractError>>({
      code: "REQUEST_REJECTED_LLL",
      message: "Vendor request rejection sequence was classified.",
    });
    expect(String(failure)).not.toContain("private");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retains ordered local-deadline and pre-deadline attempts", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(AbortSignal.abort())
      .mockReturnValueOnce(new AbortController().signal)
      .mockReturnValueOnce(AbortSignal.abort());
    const fetch = rejectingFetch([
      new Error("private first detail"),
      new Error("private second detail"),
      new Error("private third detail"),
    ]);

    const failure = await captureFailure(fetch);
    timeout.mockRestore();

    expect(failure).toMatchObject<Partial<ContractError>>({
      code: "REQUEST_REJECTED_LEL",
      message: "Vendor request rejection sequence was classified.",
    });
    expect(String(failure)).not.toContain("private");
  });

  it("preserves other rejection categories after the local deadline fires", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(AbortSignal.abort());
    const fetch = rejectingFetch([
      new DOMException("private timeout detail", "TimeoutError"),
      new TypeError("private fetch detail"),
      "private non-Error detail",
    ]);

    const failure = await captureFailure(fetch);
    timeout.mockRestore();

    expect(failure).toMatchObject<Partial<ContractError>>({
      code: "REQUEST_REJECTED_TFV",
      message: "Vendor request rejection sequence was classified.",
    });
    expect(String(failure)).not.toContain("private");
  });

  it("classifies non-Error thrown values without retaining them", async () => {
    const fetch = rejectingFetch([
      "private string detail",
      { private: "object detail" },
      null,
    ]);

    const failure = await captureFailure(fetch);

    expect(failure).toMatchObject<Partial<ContractError>>({
      code: "REQUEST_REJECTED_VVV",
      message: "Vendor request rejection sequence was classified.",
    });
    expect(String(failure)).not.toContain("private");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("clamps retry-after delays to the shared request deadline", async () => {
    let now = 0;
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "999" },
        }),
      ),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      requestWithRetry(
        "https://example.com",
        {},
        {
          fetch,
          now: () => now,
          deadlineAt: 60_000,
          sleep: async (milliseconds) => {
            now += milliseconds;
          },
        },
        "Vendor",
      ),
    ).rejects.toMatchObject({ code: "REQUEST_DEADLINE" });
    expect(now).toBe(60_000);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
