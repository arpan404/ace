import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveThreadStatus } from "@ace/core";
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
        sandbox: mode !== "auto-review" ? "read-only" : "workspace-write",
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
          type: mode !== "auto-review" ? "readOnly" : "workspaceWrite",
          networkAccess: false,
        },
      });
      if (mode === "auto-review")
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

test.each([false, true])(
  "Ask holds a shell edit for a human before changing the workspace, resume=%s",
  async (resume) => {
    const h = await sessionHarness(resume, "", undefined, undefined, undefined, "ask");
    try {
      const path = join(h.cwd, "README.md");
      await writeFile(path, "original\n");
      await h.session.send([{ type: "text", text: "shell-edit" }], "queue");
      await h.wait(
        (f) =>
          obj(f.data).method === "item/commandExecution/requestApproval" ||
          obj(f.data).method === "turn/completed",
      );
      expect(await readFile(path, "utf8")).toBe("original\n");
      expect(deriveThreadStatus(h.replay.state).state).toBe("needs_you");
      const interaction = Object.values(h.replay.state.interactions).find(
        (i) => i.request.kind === "approval",
      );
      expect(interaction?.state).toBe("pending");
      await h.session.resolve(h.requestKey(100), { kind: "approval", optionId: "accept" });
      await h.wait((f) => obj(f.data).method === "turn/completed");
      expect(await readFile(path, "utf8")).toBe("original\nQA approval test\n");
    } finally {
      await h.dispose();
    }
  },
);

test("denying an Ask shell edit leaves the workspace unchanged", async () => {
  const h = await sessionHarness(false, "", undefined, undefined, undefined, "ask");
  try {
    const path = join(h.cwd, "README.md");
    await writeFile(path, "original\n");
    await h.session.send([{ type: "text", text: "shell-edit" }], "queue");
    await h.wait((f) => obj(f.data).method === "item/commandExecution/requestApproval");
    await h.session.resolve(h.requestKey(100), { kind: "approval", optionId: "decline" });
    await h.wait((f) => obj(f.data).method === "turn/completed");
    expect(await readFile(path, "utf8")).toBe("original\n");
  } finally {
    await h.dispose();
  }
});

test.each(
  (["ask", "auto-review"] as const).flatMap((mode) =>
    (["start", "resume", "fork"] as const).map((operation) => ({ mode, operation })),
  ),
)(
  "native MCP registration preserves $mode workspace guards on $operation and later turns",
  async ({ mode, operation }) => {
    const url = "http://127.0.0.1:12345/mcp";
    const h = await sessionHarness(
      operation === "resume",
      "",
      operation === "fork"
        ? { nativeSessionId: "source-native", point: { type: "turn", nativeId: "source-turn" } }
        : undefined,
      undefined,
      { url, bearer: "b".repeat(64), signal: new AbortController().signal, end() {} },
      mode,
    );
    try {
      const opening = h.frames.find(
        (frame) => frame.dir === "send" && obj(frame.data).method === `thread/${operation}`,
      );
      expect(obj(obj(opening?.data).params)).toMatchObject({
        sandbox: mode === "ask" ? "read-only" : "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        config: {
          "sandbox_workspace_write.writable_roots": [h.cwd],
          "sandbox_workspace_write.network_access": false,
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
          "mcp_servers.ace": {
            url,
            http_headers: { Authorization: "Bearer <ACE_MCP_CREDENTIAL>" },
          },
        },
      });
      await h.session.send([{ type: "text", text: "running" }], "queue");
      const turning = h.frames.find(
        (frame) => frame.dir === "send" && obj(frame.data).method === "turn/start",
      );
      expect(obj(obj(turning?.data).params)).toMatchObject({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: mode === "ask" ? "readOnly" : "workspaceWrite",
          networkAccess: false,
        },
      });
    } finally {
      await h.dispose();
    }
  },
);
