import { useStartup, useStartupConnection, useStartupState } from "@/lib/startup/startup.tsx";
import { StartupLayout, StartupStatus } from "./startup-layout.tsx";

const words = {
  connecting: "Connecting…",
  starting: "Starting ace…",
  reconnecting: "Reconnecting…",
} as const;

/**
 * Connecting, before the app. At boot the startup screen above says so and this shows nothing;
 * it reports where the connection has got to and what "Connect manually…" does from here. Once
 * the startup screen has gone (connecting to another daemon later), it shows the same frame.
 */
export function StartupPending(props: {
  state?: "connecting" | "starting" | "reconnecting";
  onConnectManually?: (() => void) | undefined;
}) {
  const state = props.state ?? "connecting";
  useStartupConnection(state, props.onConnectManually);
  const startup = useStartup();
  const { phase } = useStartupState();
  if (startup && !finished(phase)) return null;
  return (
    <StartupLayout busy>
      <StartupStatus message={words[state]} />
    </StartupLayout>
  );
}

const finished = (phase: string) => phase === "leaving" || phase === "gone";
