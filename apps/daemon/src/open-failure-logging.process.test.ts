import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { Capabilities, Command } from "@ace/protocol";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { ManualClock } from "./engine/test-support.ts";

test("daemon open failures persist redacted warnings at the warn log threshold even when the diagnostic hook throws", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-open-warning-"));
  vi.stubEnv("ACE_ACCOUNTS_DB", join(home, "accounts.sqlite"));
  vi.stubEnv("ACE_MAINTENANCE", "0");
  const registry = new AdapterRegistry();
  const scripted = createScriptedAdapter({
    provider: "codex",
    capabilities: Capabilities.parse({
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: false,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: false,
      rewindFiles: false,
    }),
    createTranslator: () => ({ translate: () => [], tick: () => [] }),
    steps: [],
  });
  registry.register(
    {
      ...scripted,
      async openSession() {
        throw {
          code: "invalid_model",
          title: "Cannot open",
          detail: 'Cannot select model: {"credentials":{"login":"opaque-login-value"}}',
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "warn" }),
    history: { instances: [] },
    modelInstances: [],
    engine: {
      registry,
      clock: new ManualClock(),
      onSessionOpenFailure: () => {
        throw new Error("private-callback-secret");
      },
    },
  });
  try {
    const engine = daemon.engine;
    if (!engine) throw new Error("Engine unavailable");
    const workspaceId = daemon.store.createWorkspace(home, "Synthetic workspace");
    const command = Command.parse({
      id: "open-fails",
      deviceId: "warning-test",
      payload: {
        type: "thread.create",
        workspaceId,
        provider: "codex",
        input: [{ type: "text", text: "unsent" }],
      },
    });
    expect(
      daemon.store.recordCommand(command.id, command.deviceId, () =>
        engine.handler.handle(command, daemon.store),
      ).ok,
    ).toBe(true);
    await engine.flush();
    const thread = daemon.store.listThreads()[0];
    if (!thread) throw new Error("Missing thread");
    expect(engine.queue(thread.id)).toMatchObject({
      paused: true,
      reason: "manual",
      messages: [{ state: "queued" }],
    });
    const snapshot = daemon.store.snapshotThread(thread.id);
    expect(JSON.stringify(snapshot)).not.toContain("opaque-login-value");
    expect(JSON.stringify(snapshot)).not.toContain("private-callback-secret");
    await daemon.close();
    const log = await readFile(join(home, "logs", "ace.jsonl"), "utf8");
    const records = z
      .array(z.object({ level: z.string(), message: z.string(), data: z.unknown() }))
      .parse(
        log
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "Provider session opening failed",
        data: expect.objectContaining({
          code: "invalid_model",
          title: "Cannot open",
          detail: expect.stringContaining("Cannot select model"),
        }),
      }),
    );
    expect(log).not.toContain("opaque-login-value");
    expect(log).not.toContain("private-callback-secret");
    expect(scripted.commands.filter((entry) => entry.type === "send")).toEqual([]);
  } finally {
    await daemon.close();
    await registry.close();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
