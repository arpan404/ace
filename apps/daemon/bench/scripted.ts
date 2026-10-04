import { z } from "zod";
import { Capabilities } from "@ace/protocol";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame, ProviderAdapter, SessionContext } from "@ace/engine-api";
import type { Fact } from "@ace/core";

const Data = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start") }),
  z.object({ kind: z.literal("end") }),
  z.object({ kind: z.literal("delta"), index: z.number().int(), sentAt: z.number() }),
]);
export function scriptedProvider() {
  const sessions = new Map<string, SessionContext>();
  let seq = 0;
  const frame = (data: z.infer<typeof Data>): Frame => {
    const payload = new ProviderPayload(JSON.stringify(data));
    return { seq: ++seq, t: 0, dir: "recv", channel: "perf", data: payload.data, payload };
  };
  const adapter: ProviderAdapter = {
    provider: "codex",
    capabilities: () =>
      Capabilities.parse({
        // This in-process script executes no tools or native provider code.
        // Declare the default mode so #84 admission can actually start sessions.
        permissions: { modes: ["auto-review"], nativeAutoReview: false, toolGate: true },
        steer: false,
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
    createTranslator: () => ({
      tick: () => [],
      translate(input): Fact[] {
        const data = Data.parse(input.data);
        if (data.kind === "end")
          return [{ type: "turn.ended", agent: "root", outcome: "completed" }];
        if (data.kind === "start")
          return [
            { type: "turn.started", agent: "root", trigger: "user" },
            {
              type: "item.upsert",
              agent: "root",
              item: "stream",
              draft: {
                type: "message",
                role: "assistant",
                parts: [{ type: "text", text: "" }],
                complete: false,
              },
            },
          ];
        return [
          {
            type: "item.delta",
            agent: "root",
            item: "stream",
            field: "text",
            append: JSON.stringify({ index: data.index, sentAt: data.sentAt }) + "\n",
          },
        ];
      },
    }),
    async openSession(context) {
      sessions.set(context.threadId, context);
      return {
        nativeSessionId: `perf-${context.threadId}`,
        async send() {
          await context.onFrame(frame({ kind: "start" }));
        },
        async interrupt() {},
        async resolve() {},
        async stopTask() {},
        async close() {
          sessions.delete(context.threadId);
          context.onExit({ deliberate: true });
        },
      };
    },
  };
  return {
    adapter,
    async finish(thread: string) {
      const context = sessions.get(thread);
      if (!context) throw new Error("Scripted session missing");
      await context.onFrame(frame({ kind: "end" }));
      context.onExit({ deliberate: true });
      sessions.delete(thread);
    },
    async emit(thread: string, index: number) {
      const context = sessions.get(thread);
      if (!context) throw new Error("Scripted session missing");
      await context.onFrame(
        frame({ kind: "delta", index, sentAt: performance.timeOrigin + performance.now() }),
      );
    },
  };
}
