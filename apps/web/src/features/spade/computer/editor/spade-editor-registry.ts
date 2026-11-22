import { ensureEditorReady } from "@/features/editor";
import {
  createBufferRegistry,
  deviceDrafts,
  workerMerge,
  type Author,
  type BufferKey,
  type BufferRegistry,
} from "@/features/editor-workbench/index.ts";
import type { SpadeTarget } from "../../spade-requests.ts";
import { spadeFilePort, type SpadeFilesAccess } from "./spade-file-port.ts";

/*
 * The buffers behind every bot's editor (docs/editor/workbench.md 46–58), one registry per Spade
 * connection so the memory cap counts every open file there. A root names one bot on one machine;
 * each editor binds its root to the bot's Spade, its write gate and its name as it renders. Drafts
 * live on the device as the code editor's do, so unsaved text survives a reload.
 */

interface Bound extends SpadeFilesAccess {
  /** The bot's name: the editor says "Scout changed lines 2–3" when it writes under an edit. */
  name: string;
}

/** One Spade connection's buffers, and the bots its editors have bound. */
interface SpadeBuffers {
  registry: BufferRegistry;
  bound: Map<string, Bound>;
}

const made = new WeakMap<object, SpadeBuffers>();

/** The buffer root of one bot's files on one machine. */
export const spadeEditorRoot = (machine: string, bot: string) => `spade:${machine}:${bot}`;

/** The buffers for one Spade connection, made on first use. */
function buffersOf(connection: object): SpadeBuffers {
  const known = made.get(connection);
  if (known) return known;
  const bound = new Map<string, Bound>();
  const accessOf = (root: string): SpadeFilesAccess => {
    const access = bound.get(root);
    if (!access) throw new Error("This bot's files are closed.");
    return access;
  };
  // Every disk change in a bot's files is the bot's: it is the only other writer there.
  const authorOf = (key: BufferKey): Author => {
    const name = bound.get(key.root)?.name;
    return name ? { kind: "agent", agent: name, threadId: key.root } : { kind: "unknown" };
  };
  const registry = createBufferRegistry({
    files: spadeFilePort(accessOf),
    drafts: deviceDrafts(),
    merge: workerMerge(ensureEditorReady),
    now: () => Date.now(),
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    ready: ensureEditorReady,
    attribute: authorOf,
  });
  const fresh = { registry, bound };
  made.set(connection, fresh);
  return fresh;
}

/**
 * Binds `root` to a bot's Spade, as its editor renders. A binding is never dropped: buffers of a
 * closed editor that still hold unsaved text keep reading and saving through it, and an editor
 * shown again rebinds before its buffers read.
 */
export function bindSpadeRoot(root: string, access: Bound): void {
  buffersOf(access.target).bound.set(root, access);
}

/** The registry behind a Spade connection's editors. */
export function spadeEditorRegistry(connection: SpadeTarget): BufferRegistry {
  return buffersOf(connection).registry;
}
