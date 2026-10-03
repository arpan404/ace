import { expect, test } from "vitest";
import { harness } from "./session.test-helper.ts";
import { object } from "./native.ts";

test.each([
  ["auto-review", "default"],
  ["ask", "default"],
  ["read-only", "default"],
  ["full-access", "bypassPermissions"],
] as const)(
  "%s keeps Claude permission grants under ace's policy",
  async (mode, permissionMode) => {
    const h = await harness(undefined, "root", {}, { permissionMode: mode });
    try {
      const frame = await h.wait(
        (candidate) =>
          object(candidate.data).subtype === "fake_control" &&
          object(object(candidate.data).request).subtype === "initialize",
      );
      expect(object(frame.data).settings).toMatchObject({ permissionMode, settingSources: [] });
      if (mode !== "full-access") {
        await h.session.send([{ type: "text", text: "permission-gate" }], "queue");
        const response = await h.wait(
          (candidate) => object(candidate.data).subtype === "fake_resolution",
        );
        expect(object(object(response.data).response).response).toMatchObject({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: "ace permission policy reviews this exact tool call",
          },
        });
      }
    } finally {
      await h.session.close("shutdown");
    }
  },
);

test("provider option permissionMode cannot bypass ace's resolved permissions", async () => {
  await expect(
    harness(undefined, "root", {}, { permissionMode: "ask", options: { permissionMode: "auto" } }),
  ).rejects.toThrow();
});

test.each(["resume", "fork"] as const)(
  "Claude auto-review retains its ace gate on %s",
  async (operation) => {
    const h = await harness(
      operation === "resume" ? "cdf0f865-7bc2-4f24-9d5d-9d83be2a9da9" : undefined,
      "root",
      {},
      {
        permissionMode: "auto-review",
        ...(operation === "fork"
          ? {
              fork: {
                nativeSessionId: "cdf0f865-7bc2-4f24-9d5d-9d83be2a9da9",
                point: { type: "item" as const, nativeId: "cdf0f865-7bc2-4f24-9d5d-9d83be2a9daa" },
              },
            }
          : {}),
      },
    );
    try {
      const frame = await h.wait(
        (f) =>
          object(f.data).subtype === "fake_control" &&
          object(object(f.data).request).subtype === "initialize",
      );
      expect(object(frame.data).settings).toMatchObject({
        permissionMode: "default",
        settingSources: [],
      });
      await h.session.send([{ type: "text", text: "permission-gate" }], "queue");
      const response = await h.wait((f) => object(f.data).subtype === "fake_resolution");
      expect(object(object(response.data).response).response).toMatchObject({
        hookSpecificOutput: { permissionDecision: "ask" },
      });
    } finally {
      await h.session.close("shutdown");
    }
  },
);
