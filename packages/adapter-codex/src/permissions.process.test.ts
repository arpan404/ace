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
  "Codex %s launches with native guards and routes native approval requests",
  async (mode) => {
    const h = await sessionHarness(false, "", undefined, undefined, undefined, mode);
    try {
      const open = h.frames.find((f) => f.dir === "send" && obj(f.data).method === "thread/start");
      expect(obj(obj(open?.data).params)).toMatchObject({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: mode === "read-only" ? "read-only" : "workspace-write",
        config: {
          "sandbox_workspace_write.network_access": false,
          "sandbox_workspace_write.writable_roots": [h.cwd],
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        },
      });
      await h.session.send([{ type: "text", text: "approval" }], "queue");
      const request = await h.wait(
        (f) => obj(f.data).method === "item/commandExecution/requestApproval",
      );
      expect(
        Object.values(h.replay.state.interactions).some(
          (interaction) => interaction.request.kind === "approval",
        ),
      ).toBe(true);
      expect(obj(obj(request.data).params).availableDecisions).toContain("accept");
      const turn = h.frames.find((f) => f.dir === "send" && obj(f.data).method === "turn/start");
      expect(obj(obj(turn?.data).params)).toMatchObject({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: mode === "read-only" ? "readOnly" : "workspaceWrite",
          networkAccess: false,
        },
      });
      if (mode !== "read-only")
        expect(obj(obj(obj(turn?.data).params).sandboxPolicy)).toMatchObject({
          writableRoots: [h.cwd],
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        });
    } finally {
      await h.dispose();
    }
  },
);

test.each(["resume", "fork"] as const)(
  "Codex auto-review preserves exact workspace guards on %s and subsequent turns",
  async (operation) => {
    const h = await sessionHarness(
      operation === "resume",
      "",
      operation === "fork"
        ? { nativeSessionId: "source-native", point: { type: "turn", nativeId: "source-turn" } }
        : undefined,
      undefined,
      undefined,
      "auto-review",
    );
    try {
      const open = h.frames.find(
        (f) => f.dir === "send" && obj(f.data).method === `thread/${operation}`,
      );
      expect(obj(obj(open?.data).params)).toMatchObject({
        cwd: h.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        config: {
          "sandbox_workspace_write.writable_roots": [h.cwd],
          "sandbox_workspace_write.network_access": false,
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        },
      });
      await h.session.send([{ type: "text", text: "running" }], "queue");
      const turn = h.frames.find((f) => f.dir === "send" && obj(f.data).method === "turn/start");
      expect(obj(obj(turn?.data).params)).toMatchObject({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [h.cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      });
    } finally {
      await h.dispose();
    }
  },
);

test("steering retains the active turn's permissions and the next start receives the new policy", async () => {
  let mode: "auto-review" | "full-access" = "auto-review";
  const h = await sessionHarness(false, "", undefined, undefined, undefined, mode, {
    getPermissionMode: async () => mode,
  });
  try {
    await h.session.send([{ type: "text", text: "running" }], "steer");
    await h.wait((frame) => obj(frame.data).method === "turn/started");
    mode = "full-access";
    await h.session.send([{ type: "text", text: "correction" }], "steer");
    expect(
      h.frames
        .filter(
          (frame) => frame.dir === "note" && obj(frame.data).event === "permission-mode-applied",
        )
        .map((frame) => obj(frame.data).mode),
    ).toEqual(["auto-review"]);
    await h.session.interrupt({ cascade: false });
    await h.wait((frame) => obj(frame.data).method === "turn/completed");
    await h.session.send([{ type: "text", text: "running" }], "steer");
    const start = h.frames.findLast(
      (frame) => frame.dir === "send" && obj(frame.data).method === "turn/start",
    );
    expect(obj(obj(start?.data).params)).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  } finally {
    await h.dispose();
  }
});
