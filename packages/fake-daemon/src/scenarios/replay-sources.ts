/**
 * Source files the cold-start replay scenario edits. Kept apart from the script so the
 * scenario reads like a transcript. The code is plausible relay code, not a placeholder.
 */
const replayHead = [
  'import type { Client, ReplayCursor, Thread, ThreadEvent } from "./types.ts";',
  'import { log } from "./log.ts";',
  "",
  "/** Events a resuming client still needs, and the token it resumes from next time. */",
  "export interface Replay {",
  "  events: ThreadEvent[];",
  "  resumeToken: number;",
  "  coldStart?: boolean;",
  "}",
  "",
];
const replayFromBefore = [
  "export function replayFrom(thread: Thread, cursor: ReplayCursor): Replay {",
  "  const start = thread.lastCheckpointSeq;",
  "  const events = thread.events.filter((e) => e.seq > start);",
  "  return { events, resumeToken: thread.checkpoint };",
  "}",
];
const replayFromAfter = [
  "export function replayFrom(thread: Thread, cursor: ReplayCursor): Replay {",
  "  // seq 0 means the client has nothing cached: bounded cold start",
  "  const start = cursor.lastAckedSeq === 0",
  "    ? Math.max(0, thread.headSeq - COLD_START_WINDOW)",
  "    : cursor.lastAckedSeq;",
  "  const events = thread.events.filter((e) => e.seq > start);",
  "  return { events, resumeToken: thread.headSeq, coldStart: start !== cursor.lastAckedSeq };",
  "}",
];
const sessionTop = [
  "",
  "export class ReplaySession {",
  "  private thread: Thread;",
  "  private clients = new Set<Client>();",
  "  private acked = new Map<string, number>();",
  "  constructor(thread: Thread) {",
  "    this.thread = thread;",
  "  }",
  "  attach(client: Client): void {",
  "    this.clients.add(client);",
  '    log.debug("replay.attach", { client: client.id, thread: this.thread.id });',
  "  }",
  "  detach(client: Client): void {",
  "    this.clients.delete(client);",
  "    this.acked.delete(client.id);",
  "  }",
  "  ack(client: Client, seq: number): void {",
  "    const previous = this.acked.get(client.id) ?? 0;",
  "    if (seq > previous) this.acked.set(client.id, seq);",
  "  }",
];
const onResumeBefore = [
  "  onResume(client: Client, cursor: ReplayCursor) {",
  '    client.send({ type: "resume.ack" });',
  "    for (const e of this.thread.events) client.send(e);",
  "  }",
];
const onResumeAfter = [
  "  onResume(client: Client, cursor: ReplayCursor) {",
  "    const { events, coldStart } = replayFrom(this.thread, cursor);",
  '    client.send({ type: "resume.ack", headSeq: this.thread.headSeq, coldStart });',
  "    for (const e of events) client.send(e);",
  "  }",
];
const sessionBottom = [
  "  broadcast(event: ThreadEvent): void {",
  "    for (const client of this.clients) {",
  "      if ((this.acked.get(client.id) ?? 0) >= event.seq) continue;",
  "      client.send(event);",
  "    }",
  "  }",
  "  close(): void {",
  '    for (const client of this.clients) client.send({ type: "replay.closed" });',
  "    this.clients.clear();",
  "    this.acked.clear();",
  "  }",
  "}",
  "",
];
const constant = ["", "const COLD_START_WINDOW = 200;", ""];

const join = (...parts: string[][]) => parts.flat().join("\n");

/** apps/server/src/replay.ts before the thread, after turn 1, and after turn 2. */
export const replayTs = {
  path: "apps/server/src/replay.ts",
  original: join(replayHead, replayFromBefore, sessionTop, onResumeBefore, sessionBottom),
  afterTurn1: join(
    replayHead,
    constant,
    replayFromAfter,
    sessionTop,
    onResumeBefore,
    sessionBottom,
  ),
  afterTurn2: join(replayHead, constant, replayFromAfter, sessionTop, onResumeAfter, sessionBottom),
};

/** A provider-style unified diff (no full file text), as Codex's apply_patch reports it. */
export const outboxDiff = {
  path: "apps/web/src/relay/outbox.ts",
  diff: [
    "--- a/apps/web/src/relay/outbox.ts",
    "+++ b/apps/web/src/relay/outbox.ts",
    "@@ -18,4 +18,8 @@ export class Outbox {",
    "   async resume(socket: RelaySocket) {",
    "-    this.buffer.length = 0;",
    "+    // keep the buffer until the daemon confirms the resume",
    '     socket.send({ type: "resume", lastAckedSeq: this.lastAckedSeq });',
    '+    const ack = await socket.waitFor("resume.ack");',
    "+    if (ack.coldStart) this.store.markBackfillNeeded(ack.headSeq);",
    "+    for (const msg of this.buffer) socket.send(msg);",
    "+    this.buffer.length = 0;",
    "   }",
    "@@ -61,3 +65,4 @@ export class Outbox {",
    "   push(message: OutboxMessage) {",
    "+    if (this.buffer.length >= MAX_BUFFERED) this.buffer.shift();",
    "     this.buffer.push(message);",
    "   }",
    "",
  ].join("\n"),
};
