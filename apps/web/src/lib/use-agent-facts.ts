import { useThreadStore } from "@ace/client-react";
import { useMemo, useSyncExternalStore } from "react";
import { agentFactsOf, type AgentFacts } from "./agent-facts.ts";
import type { Watched } from "./use-watched.ts";

const noSubscribe = () => () => {};
const noValue = () => undefined;

export function useAgentFacts<T>(
  threadId: string,
  read: (facts: AgentFacts) => Watched<T>,
  equal: (a: T, b: T) => boolean,
): T | undefined {
  const source = useThreadStore(threadId);
  const selection = useMemo(
    () => source && agentFactsOf(source).select(read, equal),
    [source, read, equal],
  );
  return useSyncExternalStore(
    selection?.subscribe ?? noSubscribe,
    selection?.getSnapshot ?? noValue,
    noValue,
  );
}
