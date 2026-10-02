import type { Key } from "./facts.ts";
import { get } from "./emit.ts";
import type { AgentRecord, ThreadState } from "./state.ts";

export function transportSignalAt(state: ThreadState): number {
  return (
    state.lastTransportSignalAt ??
    Object.values(state.agents).reduce((latest, record) => Math.max(latest, record.lastSignalAt), 0)
  );
}

/** A known delta can revive an ancestor even when its own owner is idle. */
export function hasUnresponsiveAncestor(state: ThreadState, key: Key): boolean {
  const visited = new Set<Key>();
  let current: Key | undefined = key;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const record: AgentRecord | undefined = get(state.agents, current);
    if (!record) return false;
    if (record.agent.status.state === "unresponsive") return true;
    current =
      record.agent.parentId === null
        ? undefined
        : get(state.indexes.agentKeysById, record.agent.parentId);
  }
  return false;
}

/** Ephemeral memoization shares one subtree walk across a status/deadline derivation. */
export function subtreeSignalReader(state: ThreadState): (key: Key) => number {
  const cached = new Map<Key, number>();
  const visiting = new Set<Key>();
  function read(key: Key): number {
    const signal = cached.get(key);
    if (signal !== undefined) return signal;
    const record = get(state.agents, key);
    if (!record) return 0;
    if (visiting.has(key)) return record.lastSignalAt;
    visiting.add(key);
    let latest = record.lastSignalAt;
    for (const child of Object.keys(get(state.indexes.childrenByParent, record.agent.id) ?? {}))
      latest = Math.max(latest, read(child));
    visiting.delete(key);
    cached.set(key, latest);
    return latest;
  }
  return read;
}
