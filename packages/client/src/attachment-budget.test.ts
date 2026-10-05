import { expect, test } from "vitest";
import { attachmentBytes } from "./index.ts";

test("original attachment reads require an explicit caller budget before any daemon request", async () => {
  const port = {
    request: async (): Promise<never> => {
      throw new Error("Network accessed without an explicit budget");
    },
  };
  await expect(
    attachmentBytes(port, { threadId: "thread", sha256: "1".repeat(64), variant: "original" }),
  ).rejects.toThrow("limit");
});
