/**
 * Thread content for the slow-link bench, taken from the recorded provider sessions: each
 * recorded session is folded through its provider's real translator and core, and the root
 * agent's finished items become one replayable turn. Ids, runs and times are dropped, so the
 * daemon allocates its own as it would for a live turn; the text, tool details and raw provider
 * payloads are kept, because they are what a client is sent.
 */
import { apply, createThreadState, type ItemDraft } from "@ace/core";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { ThreadId, type Item } from "@ace/protocol";
import { recordedSessions, replayProviders } from "./adapter-replay-fixtures.ts";

export interface SeedItem {
  draft: ItemDraft;
  /** Shell output, streamed into the item's output after it is created. */
  output?: string;
}
export type SeedTurn = SeedItem[];

/** Tool kinds that need other agents or a person; a seeded turn has neither. */
const skippedTools = new Set(["agent.spawn", "agent.message", "ask_user", "plan"]);

function seedItem(item: Item): SeedItem | undefined {
  if (item.type === "message") {
    if (item.role !== "assistant") return undefined;
    const {
      id: _id,
      agentId: _agent,
      runId: _run,
      createdAt: _at,
      nativeId: _native,
      ...draft
    } = item;
    return { draft };
  }
  if (item.type === "reasoning") {
    const {
      id: _id,
      agentId: _agent,
      runId: _run,
      createdAt: _at,
      nativeId: _native,
      ...draft
    } = item;
    return { draft };
  }
  if (item.type !== "tool_call" || skippedTools.has(item.call.kind)) return undefined;
  const {
    id: _id,
    agentId: _agent,
    runId: _run,
    createdAt: _at,
    nativeId: _native,
    call,
    ...rest
  } = item;
  const { id: _callId, agentId: _callAgent, backgroundTaskId: _task, detail, ...callRest } = call;
  if (detail.kind === "shell") {
    const { output, ...shell } = detail;
    return {
      draft: { ...rest, type: "tool_call", call: { ...callRest, detail: shell } },
      output: output?.tail ?? "",
    };
  }
  return { draft: { ...rest, type: "tool_call", call: { ...callRest, detail } } };
}

/** One turn per recorded session, in a stable order: provider, then fixture name. */
export async function recordedTurns(): Promise<SeedTurn[]> {
  const turns: SeedTurn[] = [];
  for (const [name, provider] of Object.entries(replayProviders))
    for (const session of await recordedSessions(provider)) {
      const threadId = ThreadId.parse(`seed-${name}`);
      const translator = provider.createTranslator({ threadId, rootKey: "root" });
      const state = createThreadState({
        threadId,
        config: { provider: provider.provider, silenceMs: provider.silenceMs },
      });
      let next = 0;
      const ids = { next: (kind: string) => `${kind}-${++next}` };
      for (const [seq, frame] of session.frames.entries()) {
        const payload = new ProviderPayload(frame.wire);
        const translated = translator.translate(
          { seq, t: frame.t, dir: frame.dir, channel: frame.channel, data: payload.data, payload },
          frame.t,
        );
        for (const fact of [...translated, ...translator.tick(frame.t)])
          apply(state, fact, { now: frame.t, ids });
      }
      const root = state.agents["root"]?.agent.id;
      const items = Object.values(state.items)
        .filter((item) => item.agentId === root)
        .flatMap((item) => seedItem(item) ?? []);
      if (items.length) turns.push(items);
    }
  return turns;
}

export interface ThreadShape {
  name: "small" | "typical" | "large";
  turns: SeedTurn[];
  items: number;
}

const count = (turns: SeedTurn[]) => turns.reduce((total, turn) => total + turn.length, 0);

/** Turns cycled from the recordings until `items` is reached. */
function cycled(source: SeedTurn[], items: number, from = 0): SeedTurn[] {
  const turns: SeedTurn[] = [];
  for (let index = from; count(turns) < items; index++) {
    const turn = source[index % source.length];
    if (!turn) throw new Error("No recorded turns");
    turns.push(turn);
  }
  return turns;
}

/**
 * The three threads the bench opens: one short exchange, a typical working thread of about 120
 * items, and a long one whose tail carries large tool output (each shell result about 24 KiB,
 * made from the recorded outputs and assistant text repeated).
 */
export function threadShapes(source: SeedTurn[]): ThreadShape[] {
  const smallTurn = source.find((turn) => turn.length >= 4 && turn.length <= 8) ?? source[0];
  if (!smallTurn) throw new Error("No recorded turns");
  const typical = cycled(source, 120, 3);
  const large = bulkyTurns(source, 1_500, 7);
  return [
    { name: "small", turns: [smallTurn], items: smallTurn.length },
    { name: "typical", turns: typical, items: count(typical) },
    { name: "large", turns: large, items: count(large) },
  ];
}

/**
 * Turns cycled from the recordings until `items` is reached, each tool output made about
 * 24 KiB from the recorded outputs and assistant text repeated: the large thread's shape.
 */
export function bulkyTurns(source: SeedTurn[], items: number, from: number): SeedTurn[] {
  const prose = source
    .flat()
    .flatMap((item) =>
      item.draft.type === "message"
        ? (item.draft.parts?.flatMap((part) => (part.type === "text" ? [part.text] : [])) ?? [])
        : [],
    )
    .join("\n");
  const bulky = (output: string) => {
    const unit = `${output}\n${prose}\n`;
    return unit.repeat(Math.ceil((24 * 1024) / Math.max(1, unit.length))).slice(0, 24 * 1024);
  };
  return cycled(source, items, from).map((turn) =>
    turn.map((item) =>
      item.output === undefined ? item : { ...item, output: bulky(item.output) },
    ),
  );
}

/** Items in `turns`. */
export const itemCount = count;
