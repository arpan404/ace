import { Capabilities, type ContentPart } from "@ace/protocol";
import type { Fact } from "@ace/core";
import type { Frame, ProviderAdapter, SessionContext } from "@ace/engine-api";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { z } from "zod";

const Input = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("items"),
    first: z.number().int().nonnegative(),
    count: z.number().int().min(1).max(128),
  }),
  z.object({ kind: z.literal("delta"), append: z.string().max(65536) }),
  z.object({
    kind: z.literal("approvals"),
    first: z.number().int().nonnegative(),
    count: z.number().int().min(1).max(128),
  }),
  z.object({ kind: z.literal("children"), count: z.number().int().min(1).max(64) }),
  z.object({ kind: z.literal("start") }),
]);
export type SyntheticInput = z.infer<typeof Input>;
export function syntheticFacts(frame: Frame): Fact[] {
  if (frame.dir !== "recv") return [];
  const input = Input.safeParse(frame.data);
  if (!input.success) return [];
  const data = input.data;
  switch (data.kind) {
    case "start":
      return [{ type: "turn.started", agent: "root", trigger: "user" }];
    case "delta":
      return [
        { type: "item.delta", agent: "root", item: "stream", field: "text", append: data.append },
      ];
    case "items":
      return Array.from({ length: data.count }, (_, i) => ({
        type: "item.upsert",
        agent: "root",
        item: `history:${data.first + i}`,
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: `item ${data.first + i}` }],
          complete: true,
        },
      }));
    case "approvals":
      return Array.from({ length: data.count }, (_, i): Fact[] => [
        {
          type: "interaction.opened",
          agent: "root",
          interaction: `approval:${data.first + i}`,
          blocking: true,
          request: {
            kind: "approval",
            title: "Synthetic approval",
            options: [{ id: "yes", label: "Yes", kind: "allow_once" }],
          },
        },
        {
          type: "interaction.closed",
          interaction: `approval:${data.first + i}`,
          state: "resolved",
        },
      ]).flat();
    case "children":
      return Array.from({ length: data.count }, (_, i): Fact[] => [
        {
          type: "agent.seen",
          agent: `child:${i}`,
          parent: "root",
          origin: "provider_subagent",
          native: { provider: "codex", nativeId: `child:${i}` },
          fidelity: "full",
          cwd: "/synthetic",
        },
        { type: "turn.started", agent: `child:${i}`, trigger: "spawn" },
        { type: "turn.ended", agent: `child:${i}`, outcome: "completed" },
      ]).flat();
  }
}

/** Runs Node fixture code, never an installed provider CLI. */
export function syntheticProvider() {
  let context: SessionContext | undefined;
  let processHandle: SupervisedProcess | undefined;
  let sequence = 0;
  let burstDone: (() => void) | undefined;
  function frame(input: SyntheticInput): Promise<unknown> {
    if (!context) throw new Error("Synthetic session is not open");
    const payload = new ProviderPayload(JSON.stringify(input));
    return Promise.resolve(
      context.onFrame({
        seq: ++sequence,
        t: sequence,
        dir: "recv",
        channel: "synthetic",
        data: payload.data,
        payload,
      }),
    );
  }
  const adapter: ProviderAdapter = {
    provider: "codex",
    capabilities: () =>
      Capabilities.parse({
        resume: true,
        subagentTranscripts: true,
        backgroundVisibility: "full",
        permissions: {
          modes: ["auto-review"],
          source: "host",
          nativeAutoReview: false,
          toolGate: true,
        },
        steer: false,
        interruptCascades: true,
        fork: false,
        backgroundTaskControl: false,
        planMode: false,
        tokenUsage: false,
        imageInput: false,
        rewindFiles: false,
      }),
    createTranslator: () => ({ translate: syntheticFacts, tick: () => [] }),
    async openSession(ctx) {
      context = ctx;
      const proc = spawnSupervised({
        command: process.execPath,
        args: [
          "-e",
          `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',()=>{const line=JSON.stringify({kind:'delta',append:'x'})+'\\n';let b='';while(Buffer.byteLength(b)+Buffer.byteLength(line)<=65536)b+=line;process.stdout.write(b);process.stdout.write('done\\n');});`,
        ],
        env: {},
        name: "ace-long-thread-synthetic",
        ...(ctx.outputFlow ? { outputFlow: ctx.outputFlow } : {}),
      });
      processHandle = proc;
      let stopped = false;
      proc.stdout.on("line", (line) => {
        if (line === "done") {
          burstDone?.();
          burstDone = undefined;
          return;
        }
        const data = Input.parse(JSON.parse(line));
        void frame(data).catch(() => {});
      });
      proc.stderr.on("line", () => {});
      const abort = () => {
        stopped = true;
        void proc.stop({ graceMs: 0 });
      };
      ctx.signal.addEventListener("abort", abort, { once: true });
      void proc.exited.then(() => {
        ctx.signal.removeEventListener("abort", abort);
        ctx.onExit({ deliberate: stopped });
      });
      return {
        nativeSessionId: "synthetic-native",
        async send(_input: ContentPart[]) {
          await frame({ kind: "start" });
        },
        async interrupt() {},
        async resolve() {},
        async stopTask() {},
        async close() {
          stopped = true;
          await proc.stop({ graceMs: 0 });
        },
      };
    },
  };
  return {
    adapter,
    frame,
    burst(): Promise<void> {
      if (!processHandle) throw new Error("Synthetic process missing");
      return new Promise((resolve) => {
        burstDone = resolve;
        processHandle?.stdin.write("burst\n");
      });
    },
    burstDeltas: Math.floor(
      65536 / Buffer.byteLength(JSON.stringify({ kind: "delta", append: "x" }) + "\n"),
    ),
  };
}
