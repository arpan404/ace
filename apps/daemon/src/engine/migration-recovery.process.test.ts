import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile, readFile, access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { SessionContext } from "@ace/engine-api";
import { AccountRegistry, AccountService, createInstance } from "@ace/accounts";
import { fixture, cleanupRecovery, text, replaceProvider } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
import { recoveryPorts } from "../services/recovery.ts";
import type { RecoveryPorts } from "./recovery.ts";

afterEach(cleanupRecovery);
const nativeId = "11111111-1111-4111-8111-111111111111";
// Scripted steps clone frames, so re-admit their trusted bytes at the provider
// boundary rather than presenting a cloned certificate to the accounts service.
function encodedContext(context: SessionContext): SessionContext {
  return {
    ...context,
    onFrame(frame) {
      const encoded = JSON.stringify(frame.data);
      if (encoded === undefined) throw new Error("Scripted frame is not JSON");
      const payload = new ProviderPayload(encoded);
      context.onFrame({ ...frame, payload, data: payload.data });
    },
  };
}
for (const scenario of ["offline", "native_lock", "external_writer", "unverified"] as const) {
  const refused = scenario !== "offline";
  test(
    refused
      ? `native migration refuses ${scenario} and preserves source history and binding`
      : "native migration copies history before resuming the destination through the accounts service",
    async () => {
      const frames = scriptFrames(),
        ports: RecoveryPorts = {};
      const h = await fixture(
        [
          {
            on: "send",
            frames: [
              frames.frame(start, {
                type: "turn.ended",
                agent: "root",
                outcome: "failed",
                error: { kind: "quota", message: "Quota" },
              }),
            ],
          },
        ],
        frames,
        { recovery: ports },
      );
      const source = join(h.home, "source"),
        target = join(h.home, "target");
      await mkdir(join(source, "sessions"), { recursive: true });
      await mkdir(target);
      const relative = join("sessions", `rollout-${nativeId}.jsonl`);
      const history = `${JSON.stringify({ type: "session_meta", payload: { id: nativeId } })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "synthetic durable history" }] } })}\n`;
      await writeFile(join(source, relative), history);
      if (scenario === "native_lock") {
        await mkdir(join(source, "thread-writer-locks"));
        await writeFile(join(source, "thread-writer-locks", `${nativeId}.lock`), "external writer");
      }
      const writer =
        scenario === "external_writer"
          ? spawn(
              process.execPath,
              ["-e", "process.stdout.write('ready');setInterval(() => {}, 1000)"],
              { stdio: ["ignore", "pipe", "pipe"] },
            )
          : undefined;
      const registry = new AccountRegistry(new DatabaseSync(join(h.home, "accounts.sqlite")));
      try {
        if (writer) await once(writer.stdout, "data");
        await registry.register(
          createInstance({ id: "account-a", provider: "codex", label: "A", homeDir: source }),
        );
        await registry.register(
          createInstance({ id: "account-b", provider: "codex", label: "B", homeDir: target }),
        );
        // The independent exclusion boundary is injected, with a real outside writer
        // in the refusal case. No production lease can be inferred from ace shutdown.
        const accounts = new AccountService({
          registry,
          now: h.clock.now,
          timeZone: "UTC",
          env: {},
          ...(scenario === "unverified"
            ? {}
            : {
                safety: {
                  acquire: async () => {
                    if (writer?.pid !== undefined) {
                      process.kill(writer.pid, 0);
                      return undefined;
                    }
                    return { release: async () => {} };
                  },
                },
              }),
        });
        let native = h.registry.get("codex").adapter;
        const original = native;
        native = {
          ...original,
          async openSession(ctx) {
            const session = await original.openSession(encodedContext(ctx));
            return {
              ...session,
              nativeSessionId: nativeId,
              async send(input, delivery, commandId) {
                if (!commandId) throw new Error("Provider requires command correlation");
                ctx.onFrame(
                  frames.frame({
                    type: "input.admitted",
                    agent: "root",
                    nativeInputId: commandId,
                    commandId,
                  }),
                );
                await session.send(input, delivery, commandId);
              },
            };
          },
        };
        const bound = accounts.bindAdapter({ ...original, create: () => native }, (context) => ({
          instanceId: context.instanceId ?? "account-a",
          role: "worker",
          estimatedLoad: 1,
        }));
        h.registry.register(bound, { installed: true, auth: "logged_in", loginHint: "unused" });
        Object.assign(
          ports,
          recoveryPorts(
            { store: h.store, now: h.clock.now, services: { accounts, accountRegistry: registry } },
            (id) => h.engine.sessionMetadata(id),
          ),
        );
        const id = await h.create();
        expect(
          Object.values(h.store.snapshotThread(id).items).filter(
            (item) => item.type === "notice" && item.level === "error",
          ),
        ).toEqual([]);
        expect(h.store.getThread(id)?.status.state).toBe("limited");
        expect(h.command({ type: "thread.send", threadId: id, input: text("following") }).ok).toBe(
          true,
        );
        await h.engine.flush();
        expect(h.engine.queue(id).messages).toEqual([
          expect.objectContaining({ input: text("following") }),
        ]);
        const replacement = replaceProvider(h, frames, [
          { on: "send", frames: [frames.frame(start, end)] },
          { on: "send", frames: [frames.frame(start, end)] },
        ]);
        const destination = h.registry.get("codex").adapter;
        native = {
          ...destination,
          async openSession(ctx) {
            const session = await destination.openSession(encodedContext(ctx));
            return {
              ...session,
              async send(input, delivery, commandId) {
                if (!commandId) throw new Error("Provider requires continuation correlation");
                ctx.onFrame(
                  frames.frame({
                    type: "input.admitted",
                    agent: "root",
                    nativeInputId: commandId,
                    commandId,
                  }),
                );
                await session.send(input, delivery, commandId);
              },
            };
          },
        };
        h.registry.register(bound, { installed: true, auth: "logged_in", loginHint: "unused" });
        const result = h.command({
          type: "thread.limit",
          threadId: id,
          expectedRevision: h.engine.queue(id).revision,
          action: "migrate_now",
          instanceId: "account-b",
        });
        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
        await h.engine.flush();
        expect(await readFile(join(source, relative), "utf8")).toBe(history);
        if (refused) {
          await expect(access(join(target, relative))).rejects.toMatchObject({ code: "ENOENT" });
          expect(h.engine.sessionMetadata(id).instanceId).toBe("account-a");
          expect(h.engine.queue(id)).toMatchObject({
            paused: true,
            messages: [expect.objectContaining({ input: text("following") })],
          });
          expect(replacement.commands.filter((command) => command.type === "send")).toHaveLength(0);
        } else {
          expect(await readFile(join(target, relative), "utf8")).toBe(history);
          expect(
            Object.values(h.store.snapshotThread(id).runs).some(
              (run) => run.trigger === "limit_resume",
            ),
          ).toBe(true);
          expect(h.engine.sessionMetadata(id)).toMatchObject({
            instanceId: "account-b",
            nativeSessionId: nativeId,
          });
          expect(h.contexts.at(-1)).toMatchObject({
            instanceId: "account-b",
            env: { CODEX_HOME: await realpath(target) },
            resume: { nativeSessionId: nativeId },
          });
          expect(replacement.commands.findLast((command) => command.type === "send")).toMatchObject(
            { input: text("following") },
          );
        }
      } finally {
        await h.engine.close();
        registry.close();
        if (writer) {
          const exited = once(writer, "exit");
          writer.kill();
          await exited;
        }
      }
    },
  );
}
