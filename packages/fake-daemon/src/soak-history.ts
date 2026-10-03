import { AgentId, ItemId, ThreadId, type Item, type ItemsPage } from "@ace/protocol";

/*
 * The soak thread's deep past, made on demand: creation sequences 1..`size` sit below the live
 * stream, and a page of them is built when asked for. A thread of a million items costs the
 * daemon nothing to hold, so paging back through it measures only the client.
 */

const questions = [
  "Why does the relay drop frames after a reconnect?",
  "Run the outbox tests again with the retry budget doubled.",
  "Summarise what changed in the replay window since yesterday.",
];
const answers = [
  "The resume handshake now carries lastAckedSeq, so the server drops frames the client already has and the replay window stays at 200 events.",
  "Doubling the retry budget made the outbox suite pass 40 times in a row; the flake was the 50 ms timer racing the ack, not the budget.",
  "Three changes: the window caps at 200 events, acks are batched per frame, and a gap now forces a fresh snapshot instead of a partial replay.",
];

function historyItem(threadId: string, agentId: string, n: number, at: number): Item {
  const user = n % 2 === 1;
  const text = user
    ? `${questions[n % questions.length]} (#${n})`
    : `${answers[n % answers.length]} (#${n})`;
  return {
    id: ItemId.parse(`${threadId}.history.${n}`),
    agentId: AgentId.parse(agentId),
    createdAt: at,
    complete: true,
    type: "message",
    role: user ? "user" : "assistant",
    parts: [{ type: "text", text }],
    synthetic: false,
    raw: [],
  };
}

/** Items with creation sequences in [1, size], strictly before `before`, oldest first. */
export function historyPage(options: {
  threadId: string;
  agentId: string;
  size: number;
  before: number;
  limit: number;
  seq: number;
  at: number;
}): ItemsPage {
  const top = Math.min(options.before, options.size + 1);
  const from = Math.max(1, top - options.limit);
  const items: Item[] = [];
  const itemSeqs: Record<string, number> = {};
  for (let n = from; n < top; n++) {
    const item = historyItem(options.threadId, options.agentId, n, options.at);
    items.push(item);
    itemSeqs[item.id] = n;
  }
  return {
    seq: options.seq,
    threadId: ThreadId.parse(options.threadId),
    items,
    itemSeqs,
    itemsBefore: from > 1 ? from : null,
  };
}
