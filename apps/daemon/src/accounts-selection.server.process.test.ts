import { expect, test } from "vitest";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AccountService, openRegistry } from "@ace/accounts";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { Command } from "@ace/protocol";
import { Engine, AdapterRegistry } from "./engine/index.ts";
import { fixture } from "./socket-test-support.ts";
import { harness, poll } from "./account-management-test-support.ts";

// Set default over the socket, reopen the registry, then create a real engine session over a socket.
// Guards mutation 4 and admission through a replaced managed home (blocker 2).
test.each([false, true])(
  "persisted default selects the native session and refuses an escaped home (replaced=%s)",
  async (replaced) => {
    const f = await harness();
    const account = await f.add();
    expect(
      await f.request(f.owner, {
        type: "accounts.setDefault",
        requestId: f.rid(),
        provider: "codex",
        instanceId: account.id,
      }),
    ).toMatchObject({ account: { isDefault: true } });
    const registry = await openRegistry(join(f.dataDir, "accounts.sqlite"));
    const accounts = new AccountService({ registry, env: f.env, now: () => 100, timeZone: "UTC" });
    const admitted: { id: string | undefined; home: string | undefined }[] = [];
    const scripted = createScriptedAdapter({
      provider: "codex",
      steps: [],
      nativeSessionId: "fake-native",
      capabilities: {
        steer: false,
        interruptCascades: false,
        resume: true,
        fork: false,
        subagentTranscripts: false,
        backgroundTaskControl: false,
        backgroundVisibility: "none",
        planMode: false,
        tokenUsage: false,
        imageInput: false,
        rewindFiles: false,
      },
      createTranslator: () => ({ translate: () => [], tick: () => [] }),
    });
    const adapters = new AdapterRegistry();
    adapters.register(
      accounts.bindAdapter({
        ...scripted,
        create: async (_env, context) => {
          admitted.push({ id: context.instanceId, home: context.env?.CODEX_HOME });
          return scripted;
        },
      }),
      { installed: true, auth: "logged_in", loginHint: "fake" },
    );
    let engine: Engine | undefined;
    const socket = await fixture({
      accounts,
      handler: {
        handle(command, context) {
          if (!engine) throw new Error("Engine unavailable");
          return engine.handler.handle(command, context);
        },
      },
    });
    engine = new Engine(socket.store, {
      registry: adapters,
      prepareWorkspace: async () => f.dataDir,
    });
    try {
      if (replaced) {
        const home = join(f.dataDir, "account-homes", account.id);
        await rm(home, { recursive: true });
        await symlink(f.normalHome, home);
      }
      const client = await socket.connect();
      await client.next();
      const command = Command.parse({
        id: randomUUID(),
        deviceId: "device",
        payload: {
          type: "thread.create",
          workspaceId: socket.workspace,
          provider: "codex",
          input: [{ type: "text", text: "controlled fake adapter" }],
        },
      });
      client.send({ type: "command", command });
      for (;;) {
        const reply = await client.next();
        if (reply.type === "commandResult" && reply.commandId === command.id) {
          expect(reply.ok).toBe(true);
          break;
        }
      }
      await engine.flush();
      if (replaced) {
        expect(admitted).toEqual([]);
        expect(scripted.sessions).toHaveLength(0);
        await poll(
          () =>
            socket.store.listThreads().find((thread) => thread.id !== socket.thread.id)?.status
              .state,
        ).toBe("failed");
      } else {
        expect(admitted).toEqual([
          { id: account.id, home: join(f.dataDir, "account-homes", account.id) },
        ]);
        const created = socket.store.listThreads().find((thread) => thread.id !== socket.thread.id);
        if (!created) throw new Error("Created thread missing");
        expect(engine.sessionMetadata(created.id).instanceId).toBe(account.id);
      }
    } finally {
      await engine.close();
      await socket.close();
      registry.close();
      await f.close();
    }
  },
);
