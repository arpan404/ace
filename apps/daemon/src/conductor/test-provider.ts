import { z } from "zod";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { AdapterRegistry, type Store } from "@ace/daemon";
import { Capabilities, ThreadId, type ConductorPlan } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import type { Fact } from "@ace/core";
import { scriptFrames, start, end } from "../engine/test-support.ts";
import { plan, review } from "./test-artifacts.ts";
import { git } from "./test-git.ts";
export interface DeckProviderOptions {
  hold?: boolean;
  cards?: ConductorPlan;
  longReview?: boolean;
  wrongReviewRevision?: boolean;
  removeWorkerTree?: boolean;
  crossProvider?: boolean;
  question?: boolean;
  quotaLimit?: boolean;
  auth?: "logged_in" | "logged_out" | "unknown";
  onSwitchClose?(thread: ThreadId): Promise<void>;
  onSend?(entry: { thread: ThreadId; text: string; cwd: string; resumed: boolean }): void;
}
/** Only the installed provider boundary is scripted; frames still pass through the engine. */
export function deckProvider(
  options: DeckProviderOptions,
  home: string,
  store: () => Store | undefined,
) {
  const frames = scriptFrames();
  const registry = new AdapterRegistry();
  const contexts = new Map<ThreadId, SessionContext>();
  const rolesPath = join(home, "roles.json");
  const roles = new Map<ThreadId, string>(
    existsSync(rolesPath)
      ? Object.entries(
          z.record(ThreadId, z.string()).parse(JSON.parse(readFileSync(rolesPath, "utf8"))),
        ).map(([thread, role]) => [ThreadId.parse(thread), role])
      : [],
  );
  const sends: { thread: ThreadId; text: string; cwd: string; resumed: boolean }[] = [];
  let hold = options.hold ?? false;
  const output = async (ctx: SessionContext, ...facts: Fact[]) => {
    await ctx.onFrame(frames.frame(...facts));
  };
  async function finish(threadId: ThreadId) {
    const ctx = contexts.get(threadId);
    if (!ctx) throw new Error("No scripted session");
    const role = roles.get(threadId) ?? "nested";
    const card = role.split(": ").at(-1) ?? "a";
    let artifact: unknown = { message: "nested result" };
    if (role.includes("planner")) artifact = { kind: "plan", plan: options.cards ?? plan() };
    else if (role.includes("reviewer"))
      artifact = {
        kind: "review",
        revision: options.wrongReviewRevision ? "0".repeat(40) : git(ctx.cwd, "rev-parse", "HEAD"),
        review: {
          ...review(card),
          ...(options.longReview ? { summary: "review evidence ".repeat(900) } : {}),
        },
      };
    else if (role.includes("worker") || role.includes("integrator")) {
      writeFileSync(join(ctx.cwd, `${card}.txt`), `${card} works\n`);
      git(ctx.cwd, "add", "--", `${card}.txt`);
      git(ctx.cwd, "commit", "--allow-empty", "-m", `Implement ${card}`);
      artifact = {
        kind: "completion",
        completion: {
          branch: git(ctx.cwd, "branch", "--show-current"),
          revision: git(ctx.cwd, "rev-parse", "HEAD"),
          summary: `Implemented ${card}`,
        },
      };
    }
    if (options.removeWorkerTree && role.includes("worker"))
      rmSync(ctx.cwd, { recursive: true, force: true });
    await output(
      ctx,
      {
        type: "item.upsert",
        agent: "root",
        item: `result-${randomUUID()}`,
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: JSON.stringify(artifact) }],
          complete: true,
        },
      },
      end,
    );
  }
  const scripted = createScriptedAdapter({
    provider: "codex",
    capabilities: Capabilities.parse({
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: false,
      rewindFiles: false,
    }),
    steps: [],
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
  });
  const adapter = {
    ...scripted,
    async openSession(ctx: SessionContext) {
      contexts.set(ctx.threadId, ctx);
      const session = await scripted.openSession(ctx);
      return {
        ...session,
        async close(reason: Parameters<typeof session.close>[0]) {
          if (store()?.getThread(ctx.threadId)?.switch?.state === "queued")
            await options.onSwitchClose?.(ctx.threadId);
          await session.close(reason);
        },
        nativeSessionId: ctx.resume?.nativeSessionId ?? `script-${ctx.threadId}`,
        async send(
          input: Parameters<typeof session.send>[0],
          delivery: Parameters<typeof session.send>[1],
        ) {
          await session.send(input, delivery);
          const text = input
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
          const entry = { thread: ctx.threadId, text, cwd: ctx.cwd, resumed: !!ctx.resume };
          sends.push(entry);
          options.onSend?.(entry);
          const role =
            roles.get(ctx.threadId) ??
            store()?.getThread(ctx.threadId)?.title ??
            (text.includes("Plan this project")
              ? "Deck planner: plan"
              : text.includes("adversarial reviewer")
                ? `Deck reviewer: ${text.match(/"objective":"Build ([^"]+)"/)?.[1] ?? "a"}`
                : text.includes("Implement this workstream")
                  ? `Deck worker: ${text.match(/"objective":"Build ([^"]+)"/)?.[1] ?? "a"}`
                  : "nested");
          roles.set(ctx.threadId, role);
          writeFileSync(rolesPath, JSON.stringify(Object.fromEntries(roles)));
          await output(ctx, start);
          if (
            role.includes("worker") &&
            options.quotaLimit &&
            !ctx.resume &&
            store()?.getThread(ctx.threadId)?.provider === "codex"
          ) {
            await output(ctx, {
              ...end,
              outcome: "failed",
              error: { kind: "quota", message: "Scripted local quota hold" },
            });
          } else if (role.includes("worker") && options.question && !ctx.resume) {
            await output(ctx, {
              type: "interaction.opened",
              agent: "root",
              interaction: "choice",
              blocking: true,
              request: {
                kind: "question",
                questions: [
                  {
                    id: "choice",
                    text: "Proceed?",
                    options: [{ id: "yes", label: "Yes" }],
                    multiSelect: false,
                    allowOther: false,
                  },
                ],
              },
            });
          } else if (
            role.includes("planner") ||
            role.includes("reviewer") ||
            (!hold && role.includes("worker"))
          )
            await finish(ctx.threadId);
        },
        async resolve(
          interaction: Parameters<typeof session.resolve>[0],
          resolution: Parameters<typeof session.resolve>[1],
        ) {
          await session.resolve(interaction, resolution);
          await finish(ctx.threadId);
        },
        async interrupt(target: Parameters<typeof session.interrupt>[0]) {
          await session.interrupt(target);
          await output(ctx, { ...end, outcome: "interrupted" });
        },
      };
    },
  };
  registry.register(adapter, {
    installed: true,
    auth: options.auth ?? "logged_in",
    loginHint: "unused",
  });
  if (options.crossProvider)
    registry.register(
      { ...adapter, provider: "claude" },
      { installed: true, auth: options.auth ?? "logged_in", loginHint: "unused" },
    );
  return {
    registry,
    sends,
    contexts,
    finish,
    async stream(threadId: ThreadId, text: string) {
      const ctx = contexts.get(threadId);
      if (!ctx) throw new Error("No scripted session");
      await output(ctx, {
        type: "item.delta",
        agent: "root",
        item: "live-child",
        field: "text",
        append: text,
      });
    },
    async beginStream(threadId: ThreadId) {
      const ctx = contexts.get(threadId);
      if (!ctx) throw new Error("No scripted session");
      await output(ctx, {
        type: "item.upsert",
        agent: "root",
        item: "live-child",
        draft: {
          type: "message",
          role: "assistant",
          complete: false,
          parts: [{ type: "text", text: "Live" }],
        },
      });
    },
    release: () => {
      hold = false;
    },
  };
}
