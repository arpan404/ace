import type { ProviderKind } from "@ace/protocol";
import { useSyncExternalStore } from "react";

/*
 * What the Deck reads from W2's buffer registry (`editor-workbench/buffers`), one fact set per
 * open path. W2 was not on this branch when the view was built, so the view declares the
 * narrow interface it needs; W2's registry provides it (directly or through a small adapter).
 */

/** Who changed a file on disk: a thread's agent, or nobody ace could name. */
export interface BufferChanger {
  /** "Claude Code", or another thread's title ("Fix relay loop"). */
  name: string;
  provider?: ProviderKind | undefined;
}

export type BufferLoad =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "deleted"; restorable: boolean }
  | { state: "binary" }
  | { state: "too-large"; bytes: number }
  | { state: "unreadable"; reason: string };

export interface BufferFacts {
  load: BufferLoad;
  /** The buffer differs from the version it was loaded or last saved from. */
  unsaved: boolean;
  /** The disk version the person's edits started from. */
  baseVersion: string | undefined;
  /** The disk version last seen by the registry's watch. */
  diskVersion: string | undefined;
  /** Who made the latest disk change, when the registry could attribute it (spec 45). */
  changedBy?: BufferChanger | undefined;
  /** An agent changed the file and the person has not looked yet (spec 21, 43). */
  unseenAgentChange: boolean;
}

export interface DeckBuffers {
  /** The same object until the path's facts change (it backs `useSyncExternalStore`). */
  facts(path: string): BufferFacts;
  /** Called whenever any path's facts change. */
  subscribe(listener: () => void): () => void;
}

const loading: BufferFacts = {
  load: { state: "loading" },
  unsaved: false,
  baseVersion: undefined,
  diskVersion: undefined,
  unseenAgentChange: false,
};

/** A path nobody has asked the registry about yet. */
export const unknownFacts: BufferFacts = loading;

export function useBufferFacts(buffers: DeckBuffers, path: string | undefined): BufferFacts {
  return useSyncExternalStore(buffers.subscribe, () =>
    path === undefined ? unknownFacts : buffers.facts(path),
  );
}

/**
 * The disk version moved under unsaved edits (spec 46): the person and someone else both
 * changed the file. Clean buffers just reload (spec 42), so they never conflict.
 */
export function diskMovedUnderEdits(facts: BufferFacts): boolean {
  return (
    facts.unsaved &&
    facts.baseVersion !== undefined &&
    facts.diskVersion !== undefined &&
    facts.baseVersion !== facts.diskVersion
  );
}
