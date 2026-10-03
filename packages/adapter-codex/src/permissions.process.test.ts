import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test("explicit full access reaches Codex on open and each turn", async () => {
  const mode = "full-access",
    approvalPolicy = "never",
    sandbox = "danger-full-access",
    type = "dangerFullAccess";
  const h = await sessionHarness(false, "", undefined, undefined, undefined, mode);
  try {
    const open = h.frames.find(
      (frame) => frame.dir === "send" && obj(frame.data).method === "thread/start",
    );
    expect(obj(obj(open?.data).params)).toMatchObject({
      approvalPolicy,
      sandbox,
      approvalsReviewer: "user",
    });
    await h.session.send([{ type: "text", text: "running" }], "queue");
    const turn = h.frames.find(
      (frame) => frame.dir === "send" && obj(frame.data).method === "turn/start",
    );
    expect(obj(obj(turn?.data).params)).toMatchObject({
      approvalPolicy,
      approvalsReviewer: "user",
      sandboxPolicy: { type },
    });
  } finally {
    await h.dispose();
  }
});

test.each(["auto-review", "ask", "read-only"] as const)(
  "Codex %s refuses unverified tool coverage before spawning",
  async (permissionMode) => {
    await expect(
      sessionHarness(false, "", undefined, undefined, undefined, permissionMode),
    ).rejects.toThrow("verified comprehensive gate");
  },
);
