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
 * Calls `send` with each scene signal the live thread list makes (`sceneSignals`). Threads a
 * paired machine's agent started are its owner's news there, so they are left out, as in
 * notifications.
 */
export function useSceneSignals(send: (signal: SceneSignal) => void) {
  const sidebar = useSidebarStore();
  const ready = useConnectionState() === "ready";
  const facts = useSidebarAll(readSignalFacts, arrayEqual);
  const seen = useRef<SignalSnapshot>(undefined);
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    if (!facts || !sidebar || !ready) return;
    const threads = sidebar.ids.flatMap((id) => sidebar.thread(id) ?? []);
    const next = signalSnapshot(threads, (thread) => !isRemoteChild(thread));
    const previous = seen.current;
    seen.current = next;
    if (previous) for (const signal of sceneSignals(previous, next)) sendRef.current(signal);
  }, [facts, sidebar, ready]);
}
