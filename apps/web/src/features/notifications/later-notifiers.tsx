import { AgentNotifier } from "./agent-notifier.tsx";
import LimitNotifier from "./limit-notifier.tsx";
import RunNotifier from "./run-notifier.tsx";
import { SpadeNotifier } from "./spade-notifier.tsx";

/** The notifiers that wait for first paint, in one chunk: automation runs, account limits and Spade. */
export default function LaterNotifiers() {
  return (
    <>
      <AgentNotifier />
      <SpadeNotifier />
      <RunNotifier />
      <LimitNotifier />
    </>
  );
}
