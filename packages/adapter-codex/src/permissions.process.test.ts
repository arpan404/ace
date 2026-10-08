import { expect, test } from "vitest";
import { codexReviewerMode } from "@ace/provider-kit/permission-modes";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";
test.each([
  ":read-only",
  ":workspace",
  ":danger-full-access",
  codexReviewerMode("auto_review"),
  codexReviewerMode("guardian_subagent"),
])("Codex receives native %s on launch and turn", async (mode) => {
  const h = await sessionHarness(false, "", undefined, undefined, undefined, mode);
  try {
    const expected = mode.startsWith("{") ? obj(JSON.parse(mode)) : { permissions: mode };
    const open = h.frames.find(
      (frame) => frame.dir === "send" && obj(frame.data).method === "thread/start",
    );
    expect(obj(obj(open?.data).params)).toMatchObject(expected);
    await h.session.send([{ type: "text", text: "running" }], "queue");
    const turn = h.frames.find(
      (frame) => frame.dir === "send" && obj(frame.data).method === "turn/start",
    );
    expect(obj(obj(turn?.data).params)).toMatchObject(expected);
    expect(obj(obj(turn?.data).params).sandboxPolicy).toBeUndefined();
  } finally {
    await h.dispose();
  }
});
test("Codex preserves native startup configuration when no selector is chosen", async () => {
  const h = await sessionHarness();
  try {
    const open = h.frames.find(
      (frame) => frame.dir === "send" && obj(frame.data).method === "thread/start",
    );
    const params = obj(obj(open?.data).params);
    expect(params.permissions).toBeUndefined();
    expect(params.approvalPolicy).toBeUndefined();
    expect(params.sandbox).toBeUndefined();
  } finally {
    await h.dispose();
  }
});
