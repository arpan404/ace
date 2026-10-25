import { z } from "zod";

/** One recorded provider frame and its offset from the start of the recording. */
export interface RecordedFrame {
  t: number;
  data: Record<string, unknown>;
}
export interface Recording {
  cliVersion: string;
  frames: RecordedFrame[];
}
/** A frame to write and how long to wait before writing it. */
export interface Scheduled {
  delayMs: number;
  frame: Record<string, unknown>;
}
export interface TurnOptions {
  /** 1-based turn number in this process; makes provider ids unique per turn. */
  turn: number;
  sessionId: string;
  /** The uuid of the user message this turn answers, echoed like the real CLI does. */
  inputId: string | undefined;
  workspace: string;
  newId: () => string;
  /** Recorded gaps are divided by this; 0 removes them. */
  speed: number;
  /** Extra text deltas appended to the last text block, to model a long streamed answer. */
  extraTextDeltas: number;
  /** Pause before each extra text delta. */
  extraDeltaMs: number;
}

const Header = z.looseObject({ cliVersion: z.string().min(1) });
const Line = z.looseObject({
  t: z.number().nonnegative(),
  dir: z.string(),
  channel: z.string(),
  data: z.unknown(),
});
const Data = z.record(z.string(), z.unknown());

/** Keeps what the CLI itself wrote on its SDK stream; control traffic is answered live. */
export function parseRecording(text: string): Recording {
  const [head, ...lines] = text.split("\n").filter((line) => line.trim());
  const header = Header.parse(JSON.parse(head ?? "{}"));
  const frames: RecordedFrame[] = [];
  for (const line of lines) {
    const entry = Line.parse(JSON.parse(line));
    if (entry.dir !== "recv" || entry.channel !== "sdk") continue;
    const data = Data.safeParse(entry.data);
    if (!data.success) continue;
    const type = data.data["type"];
    if (typeof type !== "string" || type.startsWith("control_")) continue;
    frames.push({ t: entry.t, data: data.data });
  }
  return { cliVersion: header.cliVersion, frames };
}

const fillerLine =
  "Streaming benchmark line with **bold**, `code` and a [link](https://example.invalid).\n";

/** The frames one turn writes, with ids made fresh for this turn and session. */
export function turnFrames(recording: Recording, options: TurnOptions): Scheduled[] {
  const out: Scheduled[] = [];
  const lastTextDelta = findLast(recording.frames, (frame) => isTextDelta(frame.data));
  const filler = Array.from(
    { length: options.extraTextDeltas },
    (_, index) => `${index} ${fillerLine}`,
  );
  let previous = recording.frames[0]?.t ?? 0;
  // The assistant frame that closes the stretched block carries its whole text.
  let stretchPending = false;
  for (const recorded of recording.frames) {
    const delayMs = options.speed > 0 ? Math.max(0, (recorded.t - previous) / options.speed) : 0;
    previous = recorded.t;
    const frame = rewrite(recorded.data, options);
    if (frame["type"] === "result") stampResult(frame, options);
    else if (frame["type"] === "assistant" && stretchPending)
      stretchPending = !appendText(frame, filler.join(""));
    out.push({ delayMs, frame });
    if (recorded === lastTextDelta && filler.length) {
      stretchPending = true;
      for (const text of filler)
        out.push({ delayMs: options.extraDeltaMs, frame: withDeltaText(frame, text) });
    }
  }
  return out;
}

function rewrite(value: unknown, options: TurnOptions, key = ""): Record<string, unknown> {
  const result = rewriteValue(value, options, key);
  const parsed = Data.safeParse(result);
  if (!parsed.success) throw new Error("A recorded frame must be an object");
  return parsed.data;
}
function rewriteValue(value: unknown, options: TurnOptions, key: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteValue(entry, options, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, rewriteValue(entry, options, name)]),
    );
  if (typeof value !== "string") return value;
  if (key === "uuid") return options.newId();
  if (key === "session_id") return options.sessionId;
  if (key === "user_message_uuid") return options.inputId ?? value;
  if (key === "user_message_uuids") return options.inputId ?? value;
  // Tool-use and message ids repeat across replays; real ones never do.
  if (/^(toolu|msg)_[A-Za-z0-9]+$/.test(value)) return `${value}t${options.turn}`;
  return value.includes("<WORKSPACE>") ? value.replaceAll("<WORKSPACE>", options.workspace) : value;
}
function stampResult(frame: Record<string, unknown>, options: TurnOptions) {
  if (options.inputId) {
    frame["user_message_uuid"] = options.inputId;
    frame["user_message_uuids"] = [options.inputId];
  }
  frame["queued_turn_count"] = 0;
  frame["result_index"] = options.turn;
}
function isTextDelta(data: Record<string, unknown>) {
  const event = Data.safeParse(data["event"]);
  if (!event.success || event.data["type"] !== "content_block_delta") return false;
  const delta = Data.safeParse(event.data["delta"]);
  return delta.success && delta.data["type"] === "text_delta";
}
function withDeltaText(frame: Record<string, unknown>, text: string): Record<string, unknown> {
  const event = Data.parse(frame["event"]);
  return { ...frame, event: { ...event, delta: { type: "text_delta", text } } };
}
/** Extends the frame's last text block; false when it has none. */
function appendText(frame: Record<string, unknown>, text: string): boolean {
  const message = Data.safeParse(frame["message"]);
  if (!message.success || !Array.isArray(message.data["content"])) return false;
  const block = findLast(message.data["content"], (entry: unknown) => {
    const parsed = Data.safeParse(entry);
    return parsed.success && parsed.data["type"] === "text";
  });
  // Parsing copies, so the block itself is extended in place.
  const parsed = Data.safeParse(block);
  if (!parsed.success || typeof parsed.data["text"] !== "string" || typeof block !== "object")
    return false;
  Object.assign(block ?? {}, { text: parsed.data["text"] + text });
  return true;
}
function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
}
