import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { AccountRegistry, AccountService, createInstance } from "@ace/accounts";
import { fixture, cleanupRecovery, text, replaceProvider } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
import { recoveryPorts } from "../services/recovery.ts";
import type { RecoveryPorts } from "./recovery.ts";

afterEach(cleanupRecovery);
const nativeId = "11111111-1111-4111-8111-111111111111";
for (const locked of [false, true]) {
  test(
    locked
      ? "native migration refuses a writer lock and preserves source history and binding"
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
      if (locked) {
        await mkdir(join(source, "thread-writer-locks"));
        await writeFile(join(source, "thread-writer-locks", `${nativeId}.lock`), "external writer");
      }
      const registry = new AccountRegistry(new DatabaseSync(join(h.home, "accounts.sqlite")));
      try {
        await registry.register(
          createInstance({ id: "account-a", provider: "codex", label: "A", homeDir: source }),
        );
        await registry.register(
          createInstance({ id: "account-b", provider: "codex", label: "B", homeDir: target }),
        );
        // Only the independent exclusion boundary is injected; copying and native lock checks are real.
        const accounts = new AccountService({
          registry,
          now: h.clock.now,
          timeZone: "UTC",
          env: {},
          safety: { acquire: async () => ({ release: async () => {} }) },
        });
        let native = h.registry.get("codex").adapter;
        const original = native;
        native = {
          ...original,
          async openSession(ctx) {
            return { ...(await original.openSession(ctx)), nativeSessionId: nativeId };
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
        h.command({ type: "thread.send", threadId: id, input: text("following") });
        await h.engine.flush();
        const replacement = replaceProvider(h, frames, [
          { on: "send", frames: [frames.frame(start, end)] },
          { on: "send", frames: [frames.frame(start, end)] },
        ]);
        native = h.registry.get("codex").adapter;
        h.registry.register(bound, { installed: true, auth: "logged_in", loginHint: "unused" });
        expect(
          h.command({
            type: "thread.limit",
            threadId: id,
            expectedRevision: h.engine.queue(id).revision,
            action: "migrate_now",
            instanceId: "account-b",
          }).ok,
        ).toBe(true);
        await h.engine.flush();
        expect(await readFile(join(source, relative), "utf8")).toBe(history);
        if (locked) {
          await expect(access(join(target, relative))).rejects.toMatchObject({ code: "ENOENT" });
          expect(h.engine.sessionMetadata(id).instanceId).toBe("account-a");
          expect(h.engine.queue(id)).toMatchObject({
            paused: true,
            messages: [expect.objectContaining({ input: text("following") })],
          });
          expect(replacement.commands.filter((command) => command.type === "send")).toHaveLength(0);
        } else {
          expect(await readFile(join(target, relative), "utf8")).toBe(history);
          expect(h.engine.sessionMetadata(id)).toMatchObject({
            instanceId: "account-b",
            nativeSessionId: nativeId,
          });
          expect(h.contexts.at(-1)).toMatchObject({
            instanceId: "account-b",
            env: { CODEX_HOME: target },
            resume: { nativeSessionId: nativeId },
          });
          expect(replacement.commands.findLast((command) => command.type === "send")).toMatchObject(
            { input: text("following") },
          );
        }
      } finally {
        await h.engine.close();
        registry.close();
      }
    },
  );
}
