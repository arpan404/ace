import { ensureEditorReady } from "@/features/editor";
import {
  workerMerge,
  type Author,
  type MergePort,
  type TextBuffer,
} from "@/features/editor-workbench/index.ts";
import { providerOf } from "./agent-changes.ts";
import type { AgentBlock, AgentWho } from "./agent-lines.ts";
import { authorOf } from "./editor-registry.ts";
import { deviceAttribution } from "./attribution-memory.ts";
import { LiveGutter } from "./live-gutter.ts";

/*
 * The I/O shell around each open file's `LiveGutter`: one per buffer, made when the editor first
 * holds the file (so an agent's change to a hidden tab is seen too) and kept with the buffer.
 * Its diff runs on the editor's merge worker; who landed a change comes from the turn's edit
 * calls for a reload and from the clash for a merge.
 */

const gutters = new WeakMap<TextBuffer, LiveGutter>();
/** Each thread's machine and checkout, which a file's kept agent lines are keyed by. */
const scopes = new Map<string, { host: string; checkout: string }>();

/** The thread's editor says which machine and checkout its files are in (undefined: unknown). */
export function setGutterScope(
  threadId: string,
  scope: { host: string; checkout: string } | undefined,
): void {
  if (scope) scopes.set(threadId, scope);
  else scopes.delete(threadId);
}
let diff: MergePort | undefined;

/** How long typing pauses before the marks are worked out again. */
export const gutterDelay = 150;

/** Whom a change is credited to, as the gutter's hover names them. */
export function whoOf(author: Author | undefined): AgentWho | undefined {
  if (!author || author.kind === "unknown") return undefined;
  if (author.kind === "thread") return { name: author.title, provider: providerOf(author.agent) };
  return { name: author.agent, provider: providerOf(author.agent), turn: author.turn };
}

/** The editor core's line diff, off the main thread for large texts; one for every gutter. */
export function sharedDiff(): MergePort {
  diff ??= workerMerge(ensureEditorReady);
  return diff;
}

/** The file's change marks, made on first ask. */
export function liveGutterFor(buffer: TextBuffer): LiveGutter {
  let gutter = gutters.get(buffer);
  if (gutter) return gutter;
  gutter = new LiveGutter(buffer, {
    diff: sharedDiff(),
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    now: () => Date.now(),
    who: (reason) =>
      whoOf(reason === "reload" ? authorOf(buffer.key, Date.now()) : buffer.snapshot().clash?.by),
    delay: gutterDelay,
    memory: typeof localStorage === "undefined" ? undefined : deviceAttribution(localStorage),
    key: () => {
      const scope = scopes.get(buffer.key.root);
      return scope && `${scope.host}\u0000${scope.checkout}\u0000${buffer.key.path}`;
    },
  });
  gutters.set(buffer, gutter);
  return gutter;
}

/** The agents' blocks in an open file, for Next change. */
export function agentBlocksOf(
  buffers: { buffer(path: string): TextBuffer | undefined },
  path: string,
): readonly AgentBlock[] {
  const buffer = buffers.buffer(path);
  return buffer ? (gutters.get(buffer)?.state().agent ?? []) : [];
}
