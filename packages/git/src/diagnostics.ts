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

const causePatterns: readonly (readonly [GitErrorCode, RegExp])[] = [
  [
    "protected_branch",
    /protected branch|GH006|not allowed to (?:push|force push) (?:code )?to (?:protected|this) branch/i,
  ],
  ["branch_checked_out", /is already (?:checked out|used by worktree) at/i],
  ["ref_conflict", /cannot lock ref '[^']*': '[^']*' exists; cannot create/i],
  ["path_exists", /^fatal: '[^\n]*' already exists$/m],
  [
    "identity_missing",
    /author identity unknown|please tell me who you are|empty ident name|unable to auto-detect email address|no email was given/i,
  ],
  [
    "unborn_head",
    /does not have any commits yet|ambiguous argument 'HEAD'|invalid reference: HEAD|not a valid object name:? '?HEAD'?$/im,
  ],
  [
    "push_rejected",
    /\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)|updates were rejected because the (?:tip|remote)/i,
  ],
  [
    "nothing_to_commit",
    /^(?:nothing to commit|nothing added to commit|no changes added to commit)\b/m,
  ],
];
/** Specific causes outrank the generic hook, auth, conflict and network fallbacks. */
const precedence: readonly GitErrorCode[] = [
  "branch_checked_out",
  "ref_conflict",
  "path_exists",
  "identity_missing",
  "unborn_head",
  "push_rejected",
  "nothing_to_commit",
];

/** Inspect the entire stream with bounded line storage and bounded active hook identities. */
export class GitDiagnostics {
  private decoder = new StringDecoder("utf8");
  private tail = "";
  private discardedTrace = false;
  private hooks = new Set<string>();
  private hookFailed = false;
  private hookExited = false;
  private authFailed = false;
  private conflicts = false;
  private remoteUnreachable = false;
  private objectsUnavailable = false;
  /** Plain-text failures that name one cause, in the order `finish` prefers them. */
  private causes = new Set<GitErrorCode>();
  /** The Git lock file another process held, when Git failed because it exists. */
  lockFile: string | undefined;
  accept(chunk: Buffer): void {
    // Never concatenate an arbitrarily large process write into our retained state.
    for (let offset = 0; offset < chunk.length; offset += 4096)
      this.text(this.decoder.write(chunk.subarray(offset, offset + 4096)));
  }
  /** Some commands (`git commit`) report their failure on stdout. Only bounded tails are passed. */
  acceptOutput(text: string): void {
    if (/^(?:nothing to commit|nothing added to commit|no changes added to commit)\b/m.test(text))
      this.causes.add("nothing_to_commit");
  }
  finish(): GitErrorCode {
    this.text(this.decoder.end());
    this.line(this.tail);
    this.tail = "";
    // A remote's branch protection is not a local hook failure, even when it says "hook
    // declined" or a local remote's traced pre-receive hook exits non-zero.
    if (this.causes.has("protected_branch")) return "protected_branch";
    // Otherwise a hook Git itself saw exit non-zero is the cause, whatever it printed.
    if (this.hookExited) return "hook_failed";
    for (const cause of precedence) if (this.causes.has(cause)) return cause;
    return this.hookFailed
      ? "hook_failed"
      : this.authFailed
        ? "auth_failed"
        : this.conflicts
          ? "conflicts"
          : this.objectsUnavailable
            ? "objects_not_available"
            : this.remoteUnreachable
              ? "remote_unreachable"
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
          this.hookExited = true;
      } catch {
        /* Diagnostic records are optional, never a fatal decoding boundary. */
      }
      return; // Trace records never participate in the textual failure fallback.
    }
    if (!this.discardedTrace) this.plain(line);
  }
  private plain(text: string): void {
    this.objectsUnavailable ||=
      /unable to read (?:sha(?:1|256) file|tree|object)|failed to unpack tree object|missing (?:blob|tree|object)|could not fetch .* from promisor remote|could not read [a-f0-9]{40,64}|bad object [a-f0-9]{40,64}/i.test(
        text,
      );
    this.authFailed ||=
      /authentication failed|could not read (Username|Password)|permission denied \(publickey\)|authorization failed|HTTP[^\n]*40[13]|returned error: 40[13]|access denied/i.test(
        text,
      );
    this.remoteUnreachable ||=
      /could not resolve (host|hostname)|failed to connect|couldn't connect|connection refused|network is unreachable/i.test(
        text,
      );
    this.conflicts ||= /CONFLICT|unmerged files|resolve your current index/i.test(text);
    this.lockFile ??= /Unable to create '([^'\n]+\.lock)': File exists/.exec(text)?.[1];
    this.hookFailed ||= /hook[^\n]*(failed|declined)|pre-receive hook declined/i.test(text);
    for (const [cause, pattern] of causePatterns) if (pattern.test(text)) this.causes.add(cause);
  }
}
