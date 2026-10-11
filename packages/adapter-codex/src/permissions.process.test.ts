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

test("resetting a sticky Full access turn restores the CLI's configured native policy", async () => {
  let mode: string | null = ":danger-full-access";
  const h = await sessionHarness(false, "", undefined, undefined, undefined, mode, {
    getPermissionMode: async () => mode,
  });
  try {
    await h.session.send([{ type: "text", text: "same-chunk" }], "queue");
    await h.wait((f) => obj(f.data).method === "turn/completed");
    mode = null;
    await h.session.send([{ type: "text", text: "native-permissions-proof" }], "queue");
    const turns = h.frames.filter((f) => f.dir === "send" && obj(f.data).method === "turn/start");
    expect(obj(obj(turns.at(-1)?.data).params)).toMatchObject({
      permissions: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    const proof = await h.wait(
      (f) => obj(obj(obj(f.data).params).item).text === "Effective native permissions: :workspace",
    );
    expect(obj(obj(obj(proof.data).params).item).text).toBe(
      "Effective native permissions: :workspace",
    );
  } finally {
    await h.dispose();
  }
});
test("a missing configured default refuses the next turn instead of keeping Full access silently", async () => {
  let mode: string | null = ":danger-full-access";
  const h = await sessionHarness(false, "unknown-default", undefined, undefined, undefined, mode, {
    getPermissionMode: async () => mode,
  });
  try {
    await h.session.send([{ type: "text", text: "same-chunk" }], "queue");
    await h.wait((f) => obj(f.data).method === "turn/completed");
    mode = null;
    await expect(h.session.send([{ type: "text", text: "next" }], "queue")).rejects.toThrow(
      "previous native permission remains applied",
    );
    expect(
      h.frames.filter((f) => f.dir === "send" && obj(f.data).method === "turn/start"),
    ).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});

test("resetting a persisted native thread restores configured defaults before resume", async () => {
  const h = await sessionHarness(true, "", undefined, undefined, undefined, undefined, {
    getPermissionMode: async () => null,
    resetPermissions: true,
  });
  try {
    const resume = h.frames.find((f) => f.dir === "send" && obj(f.data).method === "thread/resume");
    expect(obj(obj(resume?.data).params)).toMatchObject({
      permissions: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    await h.session.send([{ type: "text", text: "native-permissions-proof" }], "queue");
    const proof = await h.wait(
      (f) => obj(obj(obj(f.data).params).item).text === "Effective native permissions: :workspace",
    );
    expect(obj(obj(obj(proof.data).params).item).text).toBe(
      "Effective native permissions: :workspace",
    );
  } finally {
    await h.dispose();
  }
});
