import { nativeIdentity, object, string } from "./contracts.ts";

/** Only explicit call IDs establish output ownership. O(delta), bounded call coverage. */
export class ShellStreams {
  private live = new Set<string>();
  private completed = new Map<string, true>();
  private limit: number;
  constructor(limit = 2048) {
    this.limit = limit;
  }
  async stream(
    body: unknown,
    scope: string,
    emit: (kind: string, body: unknown) => Promise<void>,
    scrub: (value: string) => Iterable<string>,
    chunkChars = 4096,
  ): Promise<unknown> {
    const outer = object(body);
    const nested = outer.type === "tool-call-delta";
    const update = nested ? object(outer.taskUpdate) : outer;
    const parentCallId = nested ? nativeIdentity(outer.callId) : undefined;
    if (nested && !parentCallId) return body;
    const event = object(update.event),
      tool = object(update.toolCall);
    const callId = nativeIdentity(update.callId) ?? nativeIdentity(event.callId);
    if (!callId) return body;
    const key = `${scope}:${parentCallId ?? "root"}:${callId}`;
    const output = async (value: string) => {
      for (const piece of scrub(value))
        for (let offset = 0; offset < piece.length;) {
          let end = Math.min(piece.length, offset + chunkChars);
          const high = piece.charCodeAt(end - 1),
            low = piece.charCodeAt(end);
          if (
            end < piece.length &&
            high >= 0xd800 &&
            high <= 0xdbff &&
            low >= 0xdc00 &&
            low <= 0xdfff
          )
            end++;
          const text = piece.slice(offset, end);
          offset = end;
          await emit("shell-output", {
            callId,
            text,
            ...(parentCallId ? { parentCallId } : {}),
            toolCall: { type: "shell" },
          });
        }
    };
    if (update.type === "shell-output-delta" && typeof event.text === "string") {
      if (this.completed.has(key)) return body;
      if (!this.live.has(key) && this.live.size >= this.limit)
        throw new Error("SDK live shell output identity budget exceeded");
      this.live.add(key);
      await output(event.text);
    } else if (
      update.type === "tool-call-completed" &&
      (tool.type === "shell" || tool.name === "shell")
    ) {
      if (!this.completed.has(key)) {
        if (this.live.delete(key)) {
          // No common positional cursor exists between live output and final stdout.
          // Keep the final raw result; never guess a suffix or append it a second time.
          await emit("output-coverage", {
            callId,
            parentCallId,
            text: "Live shell output retained. Final stdout/stderr remains raw evidence; overlap has no shared cursor and was not appended again.",
          });
        } else {
          const value = object(object(tool.result).value);
          for (const channel of ["stdout", "stderr"]) {
            const text = string(value[channel]);
            if (text) await output(text);
          }
        }
        this.completed.set(key, true);
        if (this.completed.size > this.limit) {
          const oldest = this.completed.keys().next().value;
          if (oldest !== undefined) this.completed.delete(oldest);
        }
      }
    } else return body;
    const marked = { ...update, aceOutputStream: true };
    return nested ? { ...outer, taskUpdate: marked } : marked;
  }
}
