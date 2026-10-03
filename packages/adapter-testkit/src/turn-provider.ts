import { ProviderPayload } from "@ace/provider-kit/payload";
import { z } from "zod";
import { Capabilities, InteractionRequest, type ProviderKind } from "@ace/protocol";
import type { Fact } from "@ace/core";
import type { Frame, ProviderAdapter } from "@ace/engine-api";

export const ScriptedTurnConfig = z.object({
  delayMs: z.number().int().min(0).max(60000).default(0),
  limitAfterTurns: z.number().int().min(0).max(10000).default(0),
  resetMs: z.number().int().min(1).max(60000).default(1000),
});
export type ScriptedTurnConfig = z.infer<typeof ScriptedTurnConfig>;
export type ScriptedTurnResponse =
  | { kind: "reply"; text: string; delayMs: number }
  | { kind: "question"; request: InteractionRequest; answer(): string; delayMs: number };
/** Local deterministic turns, with injected time and quota recovery. Never starts a CLI. */
export function createTurnProvider(options: {
  provider: ProviderKind;
  reply: string;
  config: ScriptedTurnConfig;
  respond?(text: string, cwd: string): ScriptedTurnResponse | undefined;
  markers?: { hold: string; limit: string; notice: string };
  now(): number;
  schedule(delayMs: number, callback: () => void | Promise<void>): () => void;
}): ProviderAdapter {
  const config = ScriptedTurnConfig.parse(options.config);
  const pending = new Map<string, Fact[]>();
  let sequence = 0;
  const frame = (facts: Fact[]): Frame => {
    const channel = `turn-${++sequence}`;
    pending.set(channel, facts);
    const payload = new ProviderPayload('{"scripted":true}');
    return { seq: sequence, t: options.now(), dir: "recv", channel, data: payload.data, payload };
  };
  const capabilities = Capabilities.parse({
    // Deterministic simulated turns perform no native tool execution.
    // The engine owns surfaced approval requests and permission admission.
    permissions: {
      modes: ["read-only", "ask", "auto-review", "full-access"],
      nativeAutoReview: false,
      toolGate: true,
    },
    steer: Boolean(options.markers),
    interruptCascades: false,
    resume: true,
    fork: false,
    subagentTranscripts: true,
    backgroundTaskControl: true,
    backgroundVisibility: "full",
    planMode: false,
    tokenUsage: true,
    imageInput: true,
    rewindFiles: false,
  });
  return {
    provider: options.provider,
    capabilities: () => capabilities,
    createTranslator: () => ({
      translate(incoming) {
        const facts = pending.get(incoming.channel) ?? [];
        pending.delete(incoming.channel);
        return facts;
      },
      tick: () => [],
    }),
    async openSession(ctx) {
      let closed = false;
      let turns = 0;
      let active: string | undefined;
      let question: { key: string; turn: string; answer(): string } | undefined;
      let cancel: (() => void) | undefined;
      let cancelledLimit: (() => void) | undefined;
      let emission = Promise.resolve();
      const emit = (facts: Fact[]) => {
        emission = emission.then(async () => {
          if (!closed) await ctx.onFrame(frame(facts));
        });
        return emission;
      };
      const complete = (turn: string, text: string) =>
        emit([
          {
            type: "item.upsert",
            agent: "root",
            item: `reply-${turn}`,
            draft: {
              type: "message",
              role: "assistant",
              complete: true,
              parts: [{ type: "text", text }],
            },
          },
          { type: "usage", agent: "root", inputTokens: 10, outputTokens: 5 },
          { type: "turn.ended", agent: "root", nativeTurnId: turn, outcome: "completed" },
        ]);
      const fail = () => {
        if (!closed) {
          closed = true;
          cancel?.();
          cancelledLimit?.();
          ctx.signal.removeEventListener("abort", shutdown);
          ctx.onExit({ deliberate: false, message: "Scripted frame rejected" });
        }
      };
      const shutdown = () => {
        if (closed) return;
        closed = true;
        cancel?.();
        cancelledLimit?.();
        ctx.signal.removeEventListener("abort", shutdown);
        ctx.onExit({ deliberate: true });
      };
      ctx.signal.throwIfAborted();
      ctx.signal.addEventListener("abort", shutdown, { once: true });
      return {
        nativeSessionId:
          ctx.resume?.nativeSessionId ?? `scripted-${options.provider}-${ctx.threadId}`,
        async send(input, delivery) {
          if (closed) throw new Error("Scripted session unavailable");
          if (active) {
            if (question || !options.markers || delivery !== "steer")
              throw new Error("Scripted session unavailable");
            const turn = active;
            active = undefined;
            cancel?.();
            await emit([
              {
                type: "item.upsert",
                agent: "root",
                item: `steer-${++sequence}`,
                draft: { type: "message", role: "user", complete: true, parts: input },
              },
              {
                type: "item.upsert",
                agent: "root",
                item: `reply-${turn}`,
                draft: {
                  type: "message",
                  role: "assistant",
                  complete: true,
                  parts: [{ type: "text", text: options.reply }],
                },
              },
              { type: "turn.ended", agent: "root", nativeTurnId: turn, outcome: "completed" },
            ]);
            return;
          }
          const turn = `turn-${++sequence}`;
          active = turn;
          const text = input
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
          await emit([
            { type: "turn.started", agent: "root", nativeTurnId: turn, trigger: "user" },
            {
              type: "item.upsert",
              agent: "root",
              item: `ask-${turn}`,
              draft: {
                type: "message",
                role: "user",
                complete: true,
                parts: [{ type: "text", text }],
              },
            },
          ]);
          if (closed || active !== turn) return;
          const response = options.respond?.(text, ctx.cwd);
          if (!response && options.markers && text.includes(options.markers.hold)) return;
          if (!response && options.markers && text.includes(options.markers.limit)) {
            await emit([
              { type: "retry", agent: "root", on: "rate_limit", message: options.markers.notice },
            ]);
            return;
          }
          const delayMs = response
            ? ScriptedTurnConfig.shape.delayMs.parse(response.delayMs)
            : config.delayMs;
          const finish = async () => {
            if (closed || active !== turn) return;
            active = undefined;
            if (config.limitAfterTurns && turns >= config.limitAfterTurns) {
              const until = options.now() + config.resetMs;
              await emit([
                {
                  type: "retry",
                  agent: "root",
                  on: "rate_limit",
                  until,
                  message: "Scripted usage limit",
                },
                {
                  type: "turn.ended",
                  agent: "root",
                  nativeTurnId: turn,
                  outcome: "failed",
                  error: { kind: "quota", message: "Scripted usage limit" },
                },
              ]);
              if (closed) return;
              cancelledLimit?.();
              cancelledLimit = options.schedule(config.resetMs, () => {
                turns = 0;
                return emit([{ type: "limit.cleared", agent: "root" }]).catch(fail);
              });
            } else {
              turns++;
              if (response?.kind === "question") {
                active = turn;
                const key = `question-${turn}`;
                question = { key, turn, answer: response.answer };
                await emit([
                  {
                    type: "interaction.opened",
                    agent: "root",
                    interaction: key,
                    blocking: true,
                    request: InteractionRequest.parse(response.request),
                  },
                ]);
              } else await complete(turn, response?.text ?? options.reply);
            }
          };
          if (delayMs)
            cancel = options.schedule(delayMs, () => {
              return finish().catch(fail);
            });
          else await finish();
        },
        async interrupt() {
          cancel?.();
          question = undefined;
          const turn = active;
          active = undefined;
          if (turn)
            await emit([
              { type: "turn.ended", agent: "root", nativeTurnId: turn, outcome: "interrupted" },
            ]);
        },
        async resolve(key) {
          const open = question;
          if (closed || !open || open.key !== key || active !== open.turn) return;
          question = undefined;
          active = undefined;
          await complete(open.turn, open.answer());
        },
        async stopTask() {},
        async close() {
          shutdown();
          await emission.catch(() => {});
        },
      };
    },
  };
}
