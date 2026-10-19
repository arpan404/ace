import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile, readFile, access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { SessionContext } from "@ace/engine-api";
import { Capabilities } from "@ace/protocol";
import { AccountRegistry, AccountService, createInstance } from "@ace/accounts";
import { fixture, cleanupRecovery, text, replaceProvider } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
import { recoveryPorts } from "../services/recovery.ts";
import { accountTransitions } from "../services/thread-transitions.ts";
import type { RecoveryPorts } from "./recovery.ts";
import type { TransitionIO } from "./transitions.ts";

afterEach(cleanupRecovery);
const codexLike = Capabilities.parse({
  steer: false,
  interruptCascades: false,
  resume: true,
  fork: true,
  forkPoints: ["turn", "end"],
  subagentTranscripts: true,
  backgroundTaskControl: true,
  backgroundVisibility: "full",
  planMode: false,
  tokenUsage: false,
  imageInput: true,
  rewindFiles: false,
});
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
for (const scenario of ["offline", "cli_source", "busy", "no_lease", "cli_destination"] as const) {
  // Without a provider lease, or into a normal CLI login, the move hands the conversation over.
  const handoff = scenario === "no_lease" || scenario === "cli_destination";
  // Another process has the session open: nothing changes and the move can be retried.
  const refused = scenario === "busy";
  test(
    handoff
      ? `moving off a usage limit with ${scenario} opens a fresh session with the conversation and keeps queued order`
      : refused
        ? "a move while another process has the session open is refused and keeps source history and binding"
        : `moving off a usage limit copies history (${scenario}) before the destination continues it`,
    async () => {
      const frames = scriptFrames(),
        ports: RecoveryPorts = {};
      const io: TransitionIO = {
        migrate: async () => ({ status: "refused", reason: "Accounts are not wired yet" }),
        applyPatch: async () => {},
      };
      const h = await fixture(
        [
          {
            on: "send",
            frames: [
              frames.frame(
                start,
                {
                  type: "turn.ended",
                  agent: "root",
                  outcome: "failed",
                  error: { kind: "quota", message: "Quota" },
                },
                {
                  // The limit says when it resets, so it holds what follows until then.
                  type: "retry",
                  agent: "root",
                  on: "rate_limit",
                  until: 1_000_000,
                  message: "Quota",
                },
              ),
            ],
          },
        ],
        frames,
        // Codex forks a copied session, as the real adapter advertises.
        { recovery: ports, transitions: io, capabilities: codexLike },
      );
      const source = join(h.home, "source"),
        target = join(h.home, "target");
      await mkdir(join(source, "sessions"), { recursive: true });
      await mkdir(target);
      const relative = join("sessions", `rollout-${nativeId}.jsonl`);
      const history = `${JSON.stringify({ type: "session_meta", payload: { id: nativeId } })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "synthetic durable history" }] } })}\n`;
      await writeFile(join(source, relative), history);
      const registry = new AccountRegistry(new DatabaseSync(join(h.home, "accounts.sqlite")));
      try {
        await registry.register({
          ...createInstance({ id: "account-a", provider: "codex", label: "A", homeDir: source }),
          ...(scenario === "cli_source" ? { implicit: true, env: {} } : {}),
        });
        await registry.register({
          ...createInstance({ id: "account-b", provider: "codex", label: "B", homeDir: target }),
          ...(scenario === "cli_destination" ? { implicit: true, env: {} } : {}),
        });
        // The provider's writer lock is injected; the daemon's Codex lease has its own test.
        const accounts = new AccountService({
          registry,
          now: h.clock.now,
          timeZone: "UTC",
          env: {},
          ...(scenario === "no_lease"
            ? {}
            : {
                safety: {
                  acquire: async () =>
                    scenario === "busy"
                      ? { status: "busy", reason: "Another Codex process has it open" }
                      : { status: "held", release: async () => {} },
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
        Object.assign(
          io,
          accountTransitions({
            now: h.clock.now,
            id: () => "migration",
            services: { accounts, accountRegistry: registry },
          }),
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
        } else if (handoff) {
          await expect(access(join(target, relative))).rejects.toMatchObject({ code: "ENOENT" });
          expect(h.contexts.at(-1)).toMatchObject({ instanceId: "account-b" });
          expect(h.contexts.at(-1)?.resume).toBeUndefined();
          // The handoff and the limit continuation go first, then the message that waited.
          const sent = replacement.commands.filter((command) => command.type === "send");
          expect(sent).toHaveLength(2);
          const [handed] = sent[0]?.input ?? [];
          expect(handed?.type === "text" && handed.text).toContain(`source_thread="${id}"`);
          expect(handed?.type === "text" && handed.text).toContain("\nuser: first\n");
          expect(sent[1]).toMatchObject({ input: text("following") });
          expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
          expect(h.store.getThread(id)?.status.state).toBe("done");
          expect(h.store.getThread(id)?.switch).toMatchObject({ state: "applied", lossy: true });
          expect(Object.values(h.store.snapshotThread(id).items)).toContainEqual(
            expect.objectContaining({
              type: "message",
              origin: expect.objectContaining({
                kind: "handoff",
                lossy: true,
                sources: [expect.objectContaining({ provider: "codex" })],
              }),
            }),
          );
        } else {
          expect(await readFile(join(target, relative), "utf8")).toBe(history);
          expect(
            Object.values(h.store.snapshotThread(id).runs).some(
              (run) => run.trigger === "limit_resume",
            ),
          ).toBe(true);
          expect(h.engine.sessionMetadata(id)).toMatchObject({ instanceId: "account-b" });
          // The destination forks the copy from its end, so the source session stays as it was.
          expect(h.contexts.at(-1)).toMatchObject({
            instanceId: "account-b",
            env: { CODEX_HOME: await realpath(target) },
            fork: { nativeSessionId: nativeId, point: { type: "end" } },
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
