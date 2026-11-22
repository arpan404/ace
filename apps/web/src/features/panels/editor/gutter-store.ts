import { ensureEditorReady } from "@/features/editor";
import {
  workerMerge,
  type Author,
  type MergePort,
  type TextBuffer,
} from "@/features/editor-workbench/index.ts";
import { ProviderKind } from "@ace/protocol";
import { z } from "zod";
import { providerOf } from "./agent-changes.ts";
import type { AgentBlock, AgentWho } from "./agent-lines.ts";
import { authorOf } from "./editor-registry.ts";
import { LiveGutter, type AttributionMemory, type SavedAttribution } from "./live-gutter.ts";

/*
 * The I/O shell around each open file's `LiveGutter`: one per buffer, made when the editor first
 * holds the file (so an agent's change to a hidden tab is seen too) and kept with the buffer.
 * Its diff runs on the editor's merge worker; who landed a change comes from the turn's edit
 * calls for a reload and from the clash for a merge.
 */

const gutters = new WeakMap<TextBuffer, LiveGutter>();
let diff: MergePort | undefined;

/** How long typing pauses before the marks are worked out again. */
export const gutterDelay = 150;

/** Whom a change is credited to, as the gutter's hover names them. */
export function whoOf(author: Author | undefined): AgentWho | undefined {
  if (!author || author.kind === "unknown") return undefined;
  if (author.kind === "thread") return { name: author.title, provider: providerOf(author.agent) };
  return { name: author.agent, provider: providerOf(author.agent), turn: author.turn };
}

/** The file's change marks, made on first ask. */
export function liveGutterFor(buffer: TextBuffer): LiveGutter {
  let gutter = gutters.get(buffer);
  if (gutter) return gutter;
  diff ??= workerMerge(ensureEditorReady);
  gutter = new LiveGutter(buffer, {
    diff,
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    now: () => Date.now(),
    who: (reason) =>
      whoOf(reason === "reload" ? authorOf(buffer.key, Date.now()) : buffer.snapshot().clash?.by),
    delay: gutterDelay,
    memory: deviceAttribution(),
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

const storageKey = "ace.editor.agent-lines";
/** Files whose agents' lines the device keeps; the oldest written go first. */
const keptFiles = 200;

const Saved = z.record(
  z.string(),
  z.object({
    hash: z.string(),
    written: z.number(),
    blocks: z.array(
      z.object({
        start: z.number(),
        end: z.number(),
        at: z.number(),
        who: z.object({
          name: z.string(),
          provider: z.string().optional(),
          turn: z.number().optional(),
        }),
      }),
    ),
  }),
);

/** Every file's kept lines, read leniently: anything unreadable is nothing kept. */
function load(): z.infer<typeof Saved> {
  try {
    const parsed = Saved.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Agents' lines on this device (localStorage), each file's for the exact text they were measured
 * on, so a reload (from the disk or a kept draft) shows them again while that text is unchanged.
 */
function deviceAttribution(): AttributionMemory | undefined {
  if (typeof localStorage === "undefined") return undefined;
  return {
    read: (key) => {
      const entry = load()[key];
      if (!entry) return undefined;
      const blocks = entry.blocks.map((block) => ({
        ...block,
        who: { ...block.who, provider: ProviderKind.safeParse(block.who.provider).data },
      }));
      return { hash: entry.hash, blocks } satisfies SavedAttribution;
    },
    write: (key, saved) => {
      const all = load();
      if (saved)
        all[key] = {
          hash: saved.hash,
          written: Date.now(),
          blocks: saved.blocks.map((block) => ({
            start: block.start,
            end: block.end,
            at: block.at,
            who: {
              name: block.who.name,
              ...(block.who.provider ? { provider: block.who.provider } : {}),
              ...(block.who.turn === undefined ? {} : { turn: block.who.turn }),
            },
          })),
        };
      else delete all[key];
      const kept = Object.entries(all)
        .toSorted(([, a], [, b]) => b.written - a.written)
        .slice(0, keptFiles);
      try {
        localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(kept)));
      } catch {
        // Storage full: the lines stay marked for this session only.
      }
    },
  };
}
