import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ContextService } from "@ace/context";
import { fixture, cleanupRecovery, text } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
import { prepareQueuedInput } from "../services/recovery.ts";
import type { PrepareInput } from "./input.ts";

afterEach(cleanupRecovery);
for (const provider of ["codex", "pi"] as const) {
  test(`${provider} context resolution fallback reaches the notice stream and sends remaining input`, async () => {
    const frames = scriptFrames();
    let prepare: PrepareInput | undefined;
    const h = await fixture(
      [
        { on: "send", frames: [frames.frame(start, end)] },
        { on: "send", frames: [frames.frame(start, end)] },
      ],
      frames,
      {
        prepareInput: async (...args) => {
          if (!prepare) throw new Error("Preparation unavailable");
          return prepare(...args);
        },
      },
    );
    const adapter = h.registry.get("codex").adapter;
    if (provider === "pi")
      h.registry.register(
        { ...adapter, provider },
        {
          installed: true,
          auth: "logged_in",
          loginHint: "unused",
        },
      );
    h.command({ type: "thread.create", workspaceId: h.workspace, provider, input: text("first") });
    await h.engine.flush();
    const id = h.store.listThreads()[0]?.id;
    if (!id) throw new Error("Missing thread");
    await promisify(execFile)("git", ["init", "-q", h.home]);
    const context = await ContextService.open({
      root: `${h.home}/context`,
      workspace: () => h.home,
      authorize: () => true,
      now: h.clock.now,
      id: () => "upload",
    });
    try {
      prepare = prepareQueuedInput({ services: { context } });
      h.command({
        type: "thread.send",
        threadId: id,
        input: text("inspect remaining input"),
        context: { mentions: [{ path: "missing.txt" }], attachments: [] },
      });
      await h.engine.flush();
      expect(
        Object.values(h.store.snapshotThread(id).items).some(
          (item) =>
            item.type === "notice" && item.level === "warning" && item.text.includes("missing.txt"),
        ),
      ).toBe(true);
      expect(h.adapter.commands.findLast((command) => command.type === "send")).toMatchObject({
        input: text("inspect remaining input"),
      });
    } finally {
      await context.close();
    }
  });
}
