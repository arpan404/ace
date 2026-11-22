import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { Capabilities, Command, ThreadId, type WorkspaceId } from "@ace/protocol";
import { SettingsService, fileIO } from "@ace/settings";
import { commandContext } from "../commands.ts";
import { Store } from "../store.ts";
import { AdapterRegistry } from "./registry.ts";
import { Engine } from "./index.ts";
import { EngineRepository } from "./repository.ts";
import { readSilenceMs, watchSilenceSetting } from "../services/silence-setting.ts";
import { ManualClock, scriptFrames, start } from "./test-support.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function setup(options?: { withSettings?: boolean; initialSetting?: "2m" | "5m" | "15m" }) {
  const home = mkdtempSync(join(tmpdir(), "ace-silence-"));
  const workspaceDir = join(home, "repo");
  const otherWorkspaceDir = join(home, "other-repo");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(otherWorkspaceDir, { recursive: true });

  const store = new Store(":memory:");
  const workspace = store.createWorkspace(workspaceDir, "repo", 1);
  const otherWorkspace = store.createWorkspace(otherWorkspaceDir, "other", 1);

  const frames = scriptFrames();
  const registry = new AdapterRegistry();
  const scripted = createScriptedAdapter({
    provider: "codex",
    nativeSessionId: "native-1",
    capabilities: Capabilities.parse({
      steer: true,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: true,
      rewindFiles: false,
    }),
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [frames.frame(start)] }],
  });
  registry.register(scripted, { installed: true, auth: "logged_in", loginHint: "unused" });

  const clock = new ManualClock();
  const settings = options?.withSettings
    ? new SettingsService({
        dataDir: join(home, "settings"),
        io: { ...fileIO, watch: async () => () => {} },
      })
    : undefined;
  if (settings && options?.initialSetting) {
    await settings.set("threads.unresponsiveAfter", options.initialSetting, { kind: "global" });
  }

  const initialSilenceMs = settings ? await readSilenceMs(store, settings, {}) : undefined;
  const engine = new Engine(store, {
    registry,
    clock,
    ...(initialSilenceMs === undefined ? {} : { silenceMs: initialSilenceMs }),
    ...(settings ? { resolveSilenceMs: (scope) => readSilenceMs(store, settings, scope) } : {}),
  });
  const stopWatch = settings ? await watchSilenceSetting({ store, settings, engine }) : undefined;

  cleanups.push(async () => {
    stopWatch?.();
    await engine.close();
    await registry.close();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  let commandSeq = 0;
  const sendCommand = async (payload: Command["payload"]) => {
    const command = Command.parse({
      id: `cmd-${++commandSeq}`,
      deviceId: "device-1",
      ...("threadId" in payload && payload.threadId ? { threadId: payload.threadId } : {}),
      payload,
    });
    await engine.prepareCommand(command);
    const receipt = engine.handler.handle(command, commandContext(store));
    expect(receipt.ok).toBe(true);
    await engine.flush();
    return receipt;
  };

  const startSilentThread = async (id: string, workspaceId: WorkspaceId = workspace) => {
    const threadId = ThreadId.parse(id);
    await sendCommand({
      type: "thread.create",
      threadId,
      workspaceId,
      provider: "codex",
      input: [{ type: "text", text: "think deeply" }],
    });
    expect(store.getThread(threadId)?.status.state).toBe("working");
    return threadId;
  };

  return {
    home,
    store,
    workspace,
    workspaceDir,
    otherWorkspace,
    otherWorkspaceDir,
    clock,
    settings,
    engine,
    sendCommand,
    startSilentThread,
  };
}

describe("silence timeout and threads.unresponsiveAfter", () => {
  it("defaults to 5 minutes so a silently thinking agent stays working past 60 seconds", async () => {
    const h = await setup();
    const id = await h.startSilentThread("silent-default");

    h.clock.advance(1_000 + 60_000 + 5_000);
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("working");

    h.clock.advance(1_000 + 5 * 60_000);
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("working");

    h.clock.advance(1_000 + 5 * 60_000 + 1);
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("unresponsive");
  });

  it("applies threads.unresponsiveAfter across global, workspace and thread layers and updates live threads", async () => {
    const h = await setup({ withSettings: true, initialSetting: "2m" });
    if (!h.settings) throw new Error("Expected settings");

    await h.settings.set("threads.unresponsiveAfter", "15m", {
      kind: "workspace",
      workspace: h.otherWorkspaceDir,
    });

    const tGlobal = await h.startSilentThread("t-global", h.workspace);
    const tWorkspace = await h.startSilentThread("t-workspace", h.otherWorkspace);

    // At 2m + 1ms, the global-layer thread becomes unresponsive while the 15m workspace thread stays working.
    h.clock.advance(1_000 + 2 * 60_000 + 1);
    await h.engine.flush();
    expect(h.store.getThread(tGlobal)?.status.state).toBe("unresponsive");
    expect(h.store.getThread(tWorkspace)?.status.state).toBe("working");

    // Raising the global threshold to 15m recovers the unresponsive thread back to working.
    await h.settings.set("threads.unresponsiveAfter", "15m", { kind: "global" });
    await vi.waitFor(async () => {
      await h.engine.flush();
      expect(h.store.getThread(tGlobal)?.status.state).toBe("working");
    });

    // Advancing to 5m keeps both working under 15m.
    h.clock.advance(1_000 + 5 * 60_000);
    await h.engine.flush();
    expect(h.store.getThread(tGlobal)?.status.state).toBe("working");
    expect(h.store.getThread(tWorkspace)?.status.state).toBe("working");

    // Setting a 2m override on just one thread marks only that thread unresponsive immediately.
    await h.settings.set("threads.unresponsiveAfter", "2m", {
      kind: "thread",
      thread: tWorkspace,
    });
    await vi.waitFor(async () => {
      await h.engine.flush();
      expect(h.store.getThread(tWorkspace)?.status.state).toBe("unresponsive");
    });
    expect(h.store.getThread(tGlobal)?.status.state).toBe("working");

    // At 15m + 1ms, the remaining thread becomes unresponsive too.
    h.clock.advance(1_000 + 15 * 60_000 + 1);
    await h.engine.flush();
    expect(h.store.getThread(tGlobal)?.status.state).toBe("unresponsive");
  });

  it("upgrades an older persisted thread with 60s silenceMs to the configured setting when resumed or sent", async () => {
    const h = await setup({ withSettings: true, initialSetting: "5m" });
    const id = await h.startSilentThread("t-legacy");

    // Simulate a thread state persisted by an earlier build with hardcoded 60s silenceMs.
    const repo = new EngineRepository(h.store);
    expect(repo.setSilenceMs(id, 60_000, h.clock.now())).toBe(true);
    expect(repo.state(id)?.config.silenceMs).toBe(60_000);

    // Sending a follow-up syncs the thread's silence threshold from settings (5m).
    await h.sendCommand({
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "follow up" }],
      delivery: "steer",
    });

    h.clock.advance(1_000 + 90_000);
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("working");
  });

  it("falls back to global settings when a workspace directory has been deleted", async () => {
    const h = await setup({ withSettings: true, initialSetting: "15m" });
    if (!h.settings) throw new Error("Expected settings");

    rmSync(h.workspaceDir, { recursive: true, force: true });
    await expect(readSilenceMs(h.store, h.settings, { workspaceId: h.workspace })).resolves.toBe(
      15 * 60_000,
    );
  });
});
