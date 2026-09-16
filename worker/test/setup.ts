import { vi } from "vitest";

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`Unmatched network request: ${String(input)}`);
  }),
);
