import { expect, it } from "vitest";
import { sealer } from "./crypto.ts";

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

it("a sealed value opens only with its key and for the row it was sealed to", async () => {
  const seal = sealer("ab".repeat(32), random);
  const sealed = await seal.seal("workos-refresh-token", "row-a");
  expect(sealed).not.toContain("workos-refresh-token");
  expect(await seal.open(sealed, "row-a")).toBe("workos-refresh-token");
  await expect(seal.open(sealed, "row-b")).rejects.toThrow();
  await expect(sealer("cd".repeat(32), random).open(sealed, "row-a")).rejects.toThrow();
});
