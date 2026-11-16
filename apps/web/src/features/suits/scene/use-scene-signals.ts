import { arrayEqual, useConnectionState, useSidebarAll, useSidebarStore } from "@ace/client-react";
import type { SidebarReader } from "@ace/client";
import type { SceneSignal } from "@ace/protocol/suits";
import { isRemoteChild } from "@ace/ui-core";
import { useEffect, useRef } from "react";
import { sceneSignals, signalSnapshot, type SignalSnapshot } from "./scene-signals.ts";

const separator = "\u0000";
/** What signals depend on, per thread: its status and its linked PRs' states. */
const readSignalFacts = (reader: SidebarReader) =>
  reader.ids.map((id) => {
    const thread = reader.thread(id);
    const prs = thread?.details?.linkedPrs?.map((pr) => pr.state).join(",") ?? "";
    return [id, thread?.status.state ?? "new", prs, thread?.details?.linkedPr?.state ?? ""].join(
      separator,
    );
  });

/**
 * Calls `changed` with the thread list as signals saw it before and after each change. Threads a
 * paired machine's agent started are its owner's news there, so they are left out, as in
 * notifications. The first snapshot is history and calls nothing.
 */
export function useSignalChanges(
  changed: (previous: SignalSnapshot, next: SignalSnapshot) => void,
) {
  const sidebar = useSidebarStore();
  const ready = useConnectionState() === "ready";
  const facts = useSidebarAll(readSignalFacts, arrayEqual);
  const seen = useRef<SignalSnapshot>(undefined);
  const changedRef = useRef(changed);
  useEffect(() => {
    changedRef.current = changed;
  });
  useEffect(() => {
    if (!facts || !sidebar || !ready) return;
    const threads = sidebar.ids.flatMap((id) => sidebar.thread(id) ?? []);
    const next = signalSnapshot(threads, (thread) => !isRemoteChild(thread));
    const previous = seen.current;
    seen.current = next;
    if (previous) changedRef.current(previous, next);
  }, [facts, sidebar, ready]);
}

/** Calls `send` with each scene signal the live thread list makes (`sceneSignals`). */
export function useSceneSignals(send: (signal: SceneSignal) => void) {
  useSignalChanges((previous, next) => {
    for (const signal of sceneSignals(previous, next)) send(signal);
  });
}
