import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { GitErrorCode } from "./types.ts";

const Trace = z.object({
  event: z.string(),
  sid: z.string().max(1024).optional(),
  child_id: z.number().int().optional(),
  child_class: z.string().optional(),
  code: z.number().int().optional(),
});

/** Inspect the entire stream with bounded line storage and bounded active hook identities. */
export class GitDiagnostics {
  private decoder = new StringDecoder("utf8");
  private tail = "";
  private discardedTrace = false;
  private hooks = new Set<string>();
  private hookFailed = false;
  private authFailed = false;
  private conflicts = false;
  accept(chunk: Buffer): void {
    // Never concatenate an arbitrarily large process write into our retained state.
    for (let offset = 0; offset < chunk.length; offset += 4096)
      this.text(this.decoder.write(chunk.subarray(offset, offset + 4096)));
  }
  finish(): GitErrorCode {
    this.text(this.decoder.end());
    this.line(this.tail);
    this.tail = "";
    return this.hookFailed
      ? "hook_failed"
      : this.authFailed
        ? "auth_failed"
        : this.conflicts
          ? "conflicts"
          : "git_failed";
  }
  private text(text: string): void {
    const lines = (this.tail + text).split("\n");
    this.tail = lines.pop() ?? "";
    for (const line of lines) {
      this.line(line);
      this.discardedTrace = false;
    }
    if (this.tail.length > 8192) {
      // Long plain diagnostics can contain auth/conflict evidence before their last line.
      if (this.tail.includes('{"event"')) this.discardedTrace = true;
      if (!this.discardedTrace) this.plain(this.tail);
      this.tail = this.tail.slice(-8192);
    }
  }
  private line(line: string): void {
    // Hooks sometimes omit their final newline. A Trace2 record can follow that noise.
    const start = line.lastIndexOf('{"event"');
    if (start !== -1) {
      if (start) this.plain(line.slice(0, start));
      try {
        const parsed = Trace.safeParse(JSON.parse(line.slice(start)));
        if (!parsed.success || parsed.data.child_id === undefined) return;
        const event = parsed.data;
        const key = `${event.sid ?? ""}:${event.child_id}`;
        if (event.event === "child_start" && event.child_class === "hook" && this.hooks.size < 64)
          this.hooks.add(key);
        if (
          event.event === "child_exit" &&
          this.hooks.delete(key) &&
          event.code !== undefined &&
          event.code !== 0
        )
          this.hookFailed = true;
      } catch {
        /* Diagnostic records are optional, never a fatal decoding boundary. */
      }
      return; // Trace records never participate in the textual failure fallback.
    }
    if (!this.discardedTrace) this.plain(line);
  }
  private plain(text: string): void {
    this.authFailed ||=
      /authentication failed|could not read (Username|Password)|permission denied \(publickey\)|authorization failed|HTTP[^\n]*40[13]|returned error: 40[13]|access denied/i.test(
        text,
      );
    this.conflicts ||= /CONFLICT|unmerged files|resolve your current index/i.test(text);
    this.hookFailed ||= /hook[^\n]*(failed|declined)|pre-receive hook declined/i.test(text);
  }
}
