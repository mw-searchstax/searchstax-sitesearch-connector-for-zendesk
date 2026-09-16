import { expect, it } from "vitest";

it("fails unmatched network access", async () => {
  await expect(fetch("https://unmatched.invalid/")).rejects.toThrow(
    "Unmatched network request",
  );
});
