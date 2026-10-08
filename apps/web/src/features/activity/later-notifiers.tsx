import { AgentNotifier } from "./agent-notifier.tsx";
import LimitNotifier from "./limit-notifier.tsx";
import RunNotifier from "./run-notifier.tsx";

/** The notifiers that wait for first paint, in one chunk: automation runs and account limits. */
export default function LaterNotifiers() {
  return (
    <>
      <AgentNotifier />
      <RunNotifier />
      <LimitNotifier />
    </>
  );
}
