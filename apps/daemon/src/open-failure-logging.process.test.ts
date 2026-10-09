import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { Capabilities, Command } from "@ace/protocol";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { ManualClock } from "./engine/test-support.ts";

test.each(["codex", "opencode"] as const)(
  "%s open failures persist model routes and redacted warnings even when the diagnostic hook throws",
  async (provider) => {
    const home = await mkdtemp(join(tmpdir(), "ace-open-warning-"));
    vi.stubEnv("ACE_ACCOUNTS_DB", join(home, "accounts.sqlite"));
    vi.stubEnv("ACE_MAINTENANCE", "0");
    const executable = join(home, "opencode");
    if (provider === "opencode")
      await writeFile(
        executable,
        `#!${process.execPath}
const args=process.argv.slice(2).join(' ');
if(args==='--version') console.log('2.1.0');
else if(args==='auth list --standalone --format json') console.log(JSON.stringify([{id:'synthetic-cloud',connections:[{type:'env'}]}]));
else process.exit(9);
`,
        { mode: 0o700 },
      );
    const registry = new AdapterRegistry();
    const scripted = createScriptedAdapter({
      provider,
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
            detail:
              'model_unavailable: Cannot select model: {"credentials":{"login":"opaque-login-value"}}',
          };
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    const daemon = await startDaemon({
      config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "warn" }),
      history: { instances: [] },
      modelInstances:
        provider === "opencode"
          ? [
              {
                id: "opencode-cli-default",
                provider,
                executable,
                cwd: home,
                loginRevision: "synthetic",
                env: { HOME: home },
              },
            ]
          : [],
      modelDiscovery: {
        async opencode(instance) {
          return {
            location: { directory: instance.cwd },
            data: [
              {
                id: "synthetic-cloud/unavailable-model",
                providerID: "synthetic-cloud",
                modelID: "unavailable-model",
                name: "Synthetic model",
                enabled: true,
                status: "active",
                limit: { context: 1000, output: 500 },
                capabilities: { input: { text: true } },
                variants: [],
              },
            ],
          };
        },
      },
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
      if (provider === "opencode") {
        await daemon.models.refresh();
        expect(daemon.models.list().models).toMatchObject([
          { id: "synthetic-cloud/unavailable-model" },
        ]);
      }
      const workspaceId = daemon.store.createWorkspace(home, "Synthetic workspace");
      const command = Command.parse({
        id: "open-fails",
        deviceId: "warning-test",
        payload: {
          type: "thread.create",
          workspaceId,
          provider,
          ...(provider === "opencode" ? { model: "synthetic-cloud/unavailable-model" } : {}),
          input: [{ type: "text", text: "unsent" }],
        },
      });
      expect(
        daemon.store.recordCommand(command.id, command.deviceId, () =>
          engine.handler.handle(command, daemon.store),
        ),
      ).toMatchObject({ ok: true });
      await engine.flush();
      const thread = daemon.store.listThreads()[0];
      if (!thread) throw new Error("Missing thread");
      expect(engine.queue(thread.id)).toMatchObject({
        paused: true,
        reason: "model_unavailable",
        messages: [{ state: "queued" }],
      });
      const snapshot = daemon.store.snapshotThread(thread.id);
      expect(JSON.stringify(snapshot)).not.toContain("opaque-login-value");
      expect(JSON.stringify(snapshot)).not.toContain("private-callback-secret");
      if (provider === "opencode") {
        const rejected = Command.parse({
          id: "model-missing",
          deviceId: "warning-test",
          payload: {
            type: "thread.create",
            workspaceId,
            provider,
            model: "synthetic-cloud/missing",
            input: [{ type: "text", text: "unsent" }],
          },
        });
        expect(engine.handler.handle(rejected, daemon.store)).toMatchObject({
          ok: false,
          error: "model_unavailable",
        });
      }
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
            provider,
            code: "invalid_model",
            title: "Cannot open",
            detail: expect.stringContaining("model_unavailable"),
            model: provider === "opencode" ? "synthetic-cloud/unavailable-model" : null,
            instance: null,
          }),
        }),
      );
      if (provider === "opencode")
        expect(records).toContainEqual(
          expect.objectContaining({
            message: "Selected model unavailable",
            data: expect.objectContaining({
              code: "model_unavailable",
              provider,
              model: "synthetic-cloud/missing",
            }),
          }),
        );
      expect(log).not.toContain("UNPREPARED OBJECT OMITTED");
      expect(log).not.toContain("opaque-login-value");
      expect(log).not.toContain("private-callback-secret");
      expect(scripted.commands.filter((entry) => entry.type === "send")).toEqual([]);
    } finally {
      await daemon.close();
      await registry.close();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  },
);
