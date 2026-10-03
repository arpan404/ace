import { CursorEnvelopeSchema } from "@ace/adapter-cursor";
import { apply, createThreadState, type IdSource } from "@ace/core";
import { boundedJson } from "@ace/provider-kit/ipc";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame, Translator } from "@ace/engine-api";
import { ThreadId, ThreadStatus, AgentStatus } from "@ace/protocol";
import { z } from "zod";

const Update = z.object({ type: z.string().optional() });
const FrameSchema = z.object({
  seq: z.number().int().nonnegative(),
  t: z.number().finite().nonnegative(),
  dir: z.enum(["send", "recv", "note"]),
  channel: z.literal("sdk"),
  data: CursorEnvelopeSchema,
});
export const CursorSdkObservation = z.object({
  threadId: ThreadId,
  nativeAgentIds: z.array(z.string().max(512)).max(2048),
  nativeRunIds: z.array(z.string().max(512)).max(2048),
  aceRunIds: z.array(z.string().max(512)).max(2048),
  status: ThreadStatus,
  frames: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  lastBoundaryOffset: z.number().int().nonnegative(),
  observedKinds: z.array(z.string().max(128)).max(2048),
  children: z
    .array(
      z.object({
        nativeId: z.string().max(512).optional(),
        background: z.boolean(),
        fidelity: z.string().max(128),
        readOnly: z.literal(true),
        status: AgentStatus,
      }),
    )
    .max(2048),
});

/** Bounded recording fold. Canonical core owns tree settlement; raw frames stay streamed. */
export class CursorSdkEvidence {
  readonly state;
  readonly translator: Translator;
  private ids: IdSource;
  private agents = new Set<string>();
  private runs = new Set<string>();
  private kinds = new Set<string>();
  private frames = 0;
  private bytes = 0;
  lastBoundaryOffset = 0;
  throughSeq = 0;
  textObserved = false;
  toolObserved = false;
  rootEnded = false;
  constructor(threadId: ThreadId, translator: Translator, ids: IdSource) {
    this.state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90000 } });
    this.translator = translator;
    this.ids = ids;
  }
  accept(frame: Frame): Frame {
    const payload =
      frame.payload && ProviderPayload.is(frame.payload) && frame.payload.data === frame.data
        ? frame.payload
        : new ProviderPayload(boundedJson(frame.data, 262144));
    const size = payload.bytes;
    if (size > 262144) throw new Error("SDK recorder frame exceeds byte budget");
    const admitted = { ...frame, data: payload.data, payload };
    if (this.frames >= 16384 || this.bytes + size > 33554432)
      throw new Error("SDK scenario capture/evidence budget exceeded; recording incomplete");
    const parsed = FrameSchema.parse(admitted);
    const event = parsed.data;
    if (/auth|login|logout/.test(event.kind)) throw new Error("Auth must never enter SDK fixtures");
    for (const [set, value] of [
      [this.agents, event.agentId],
      [this.runs, event.runId],
      [this.kinds, event.kind],
    ] as const) {
      if (!value) continue;
      if (!set.has(value) && set.size >= 2048)
        throw new Error("SDK scenario identity budget exceeded");
      set.add(value);
    }
    this.frames++;
    this.bytes += size;
    this.lastBoundaryOffset = Math.max(this.lastBoundaryOffset, event.boundaryOffset ?? 0);
    const update = Update.safeParse(event.body);
    if (["delta", "delta-chunk"].includes(event.kind) && update.success) {
      if (update.data.type === "text-delta") this.textObserved = true;
      if (update.data.type === "tool-call-started") this.toolObserved = true;
    }
    if (event.kind === "send") this.rootEnded = false;
    for (const fact of this.translator.translate(admitted, frame.t)) {
      this.throughSeq += apply(this.state, fact, { now: frame.t, ids: this.ids }).length;
      if (fact.type === "turn.ended" && fact.agent === "root") this.rootEnded = true;
    }
    return admitted;
  }
  get status(): ThreadStatus {
    return this.state.status;
  }
  get settled(): boolean {
    return this.state.hasRun && ["done", "failed"].includes(this.status.state);
  }
  snapshot() {
    return CursorSdkObservation.parse({
      threadId: this.state.threadId,
      nativeAgentIds: [...this.agents],
      nativeRunIds: [...this.runs],
      aceRunIds: Object.keys(this.state.runs),
      status: this.status,
      frames: this.frames,
      bytes: this.bytes,
      lastBoundaryOffset: this.lastBoundaryOffset,
      observedKinds: [...this.kinds],
      children: Object.values(this.state.agents)
        .filter((record) => record.agent.origin === "provider_subagent")
        .map(({ agent }) => ({
          nativeId: agent.native?.nativeId,
          background: agent.background ?? false,
          fidelity: agent.fidelity,
          readOnly: true,
          status: agent.status,
        })),
    });
  }
}
