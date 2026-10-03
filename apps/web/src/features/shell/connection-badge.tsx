import { useConnectionState } from "@ace/client-react";
import { StatusPill } from "@/components/status-pill.tsx";
import type { Tone } from "@/lib/status.ts";

const labels = {
  connecting: { label: "Connecting", tone: "waiting" },
  ready: { label: "Connected", tone: "done" },
  reconnecting: { label: "Reconnecting", tone: "waiting" },
  offline: { label: "Offline", tone: "idle" },
  fatal: { label: "Disconnected", tone: "failed" },
} satisfies Record<string, { label: string; tone: Tone }>;

/** Connection to the daemon. Never implies anything about agent progress. */
export function ConnectionBadge() {
  const state = labels[useConnectionState()];
  return (
    <span role="status" aria-label={`Daemon: ${state.label}`}>
      <StatusPill tone={state.tone} label={state.label} />
    </span>
  );
}
