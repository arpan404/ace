import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { createCursorAdapter } from "./index.ts";
import { localPolicy } from "./policy.ts";

test("Cursor restricted execution requires a verified classifier and retains its sandbox", () => {
  expect(() => localPolicy("restricted", false)).toThrow("not downgraded");
  expect(localPolicy("restricted", true)).toMatchObject({
    sandboxOptions: { enabled: true },
    autoReview: true,
    settingSources: [],
  });
  expect(localPolicy("full-access", false)).toMatchObject({
    sandboxOptions: { enabled: false },
    autoReview: false,
  });
});

test.each(["auto-review", "ask", "read-only"] as const)(
  "Cursor rejects ace %s without silently opening full access",
  async (permissionMode) => {
    const adapter = createCursorAdapter();
    try {
      await expect(
        adapter.openSession({
          threadId: ThreadId.parse("permission"),
          cwd: "/synthetic",
          permissionMode,
          signal: new AbortController().signal,
          onFrame() {},
          onExit() {},
        }),
      ).rejects.toThrow("mode unsupported");
    } finally {
      await adapter.close();
    }
  },
);
