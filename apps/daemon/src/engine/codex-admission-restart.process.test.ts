import { expect, test } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "@ace/adapter-codex";
import { Engine, Store } from "@ace/daemon";
import { harness, scriptFrames } from "./test-support.ts";

test("fatal Codex admission cancels pending permission and holds the interrupted turn across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-admission-restart-"));
  const binary = join(directory, "offline-codex.mjs");
  await writeFile(
    binary,
    `#!${process.execPath}\nimport ${JSON.stringify(new URL("../../../../packages/adapter-codex/src/testing/cli.ts", import.meta.url).href)};\n`,
  );
  await chmod(binary, 0o755);
  const codex = createCodexAdapter({
    cli: {
      installed: true,
      path: binary,
      version: "0.159.1",
      auth: "logged_in",
      loginHint: "unused",
    },
    runtime: { stopGraceMs: 0 },
  });
  const exited = Promise.withResolvers<void>();
  const h = await harness([], scriptFrames(), {
    nativeAdapter: {
      ...codex,
      openSession(ctx) {
        return codex.openSession({
          ...ctx,
          onExit(result) {
            ctx.onExit(result);
            exited.resolve();
          },
        });
      },
    },
    permissionSettings: async () => ({ access: "ask" as const }),
  });
  let reopened: Engine | undefined;
  let persisted: Store | undefined;
  try {
    const receipt = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      input: [{ type: "text", text: "oversized-execution" }],
    });
    if (!receipt.ok || !receipt.threadId) throw new Error("Thread creation failed");
    const id = receipt.threadId;
    await exited.promise;
    await h.engine.flush();
    expect(h.store.snapshotThread(id).thread.status).toEqual({ state: "waiting", on: "queue" });
    expect(Object.values(h.store.snapshotThread(id).interactions)).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
    await h.engine.close();
    persisted = new Store(h.path);
    reopened = new Engine(persisted, { registry: h.registry, clock: h.clock });
    await reopened.flush();
    const snapshot = persisted.snapshotThread(id);
    expect(snapshot.thread.status).toEqual({ state: "waiting", on: "queue" });
    expect(reopened.queue(id)).toMatchObject({ paused: true, reason: "restart" });
    expect(Object.values(snapshot.interactions)).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
    expect(Object.values(snapshot.items).find((item) => item.type === "tool_call")).toMatchObject({
      complete: true,
      call: { status: "cancelled" },
    });
  } finally {
    await reopened?.close();
    await persisted?.close();
    await h.close();
    await rm(directory, { recursive: true, force: true });
  }
});
