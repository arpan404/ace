import type { ClientCore } from "@ace/client";
import type { ServerMessage } from "@ace/protocol";
import { browsingLabel, computerUseLabel } from "@ace/ui-core";
import { host } from "./host.ts";

/*
 * What agents drive for each thread right now, as the daemon reports it to every client
 * (`browser.browsing`, `computer.using`): the row marks the desktop draws after the project's
 * name. Asked again on every ready connection; each answer replaces the last.
 */

export interface AgentUse {
  /** Threads with an agent working in their browser. */
  browsing: ReadonlySet<string>;
  /** Threads with an agent using Mac apps, and which apps. */
  apps: ReadonlyMap<string, readonly string[]>;
}

export const noAgentUse: AgentUse = { browsing: new Set(), apps: new Map() };

/** A row's marks, worded: null where nothing is being driven. */
export function agentUseMarks(use: AgentUse, threadId: string) {
  const apps = use.apps.get(threadId) ?? [];
  return {
    browsing: use.browsing.has(threadId) ? browsingLabel : null,
    computerUse: apps.length ? computerUseLabel(apps) : null,
  };
}

/**
 * The use after `message`, and the threads whose marks changed; undefined when the message
 * isn't one of the two answers. Pure.
 */
export function readAgentUse(
  current: AgentUse,
  message: ServerMessage,
): { next: AgentUse; changed: string[] } | undefined {
  if (message.type === "browser.browsing") {
    const browsing: ReadonlySet<string> = new Set<string>(message.threads);
    const changed = [...browsing, ...current.browsing].filter(
      (id) => browsing.has(id) !== current.browsing.has(id),
    );
    return { next: { ...current, browsing }, changed: [...new Set(changed)] };
  }
  if (message.type === "computer.using") {
    const apps: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>(
      message.threads.map((entry) => [entry.threadId, entry.apps]),
    );
    const changed = [...new Set([...apps.keys(), ...current.apps.keys()])].filter(
      (id) => (apps.get(id) ?? []).join("\n") !== (current.apps.get(id) ?? []).join("\n"),
    );
    return { next: { ...current, apps }, changed };
  }
  return undefined;
}

/** Follows both reports on `owner`; `changed` names the threads whose marks moved. */
export function followAgentUse(owner: ClientCore, changed: (ids: readonly string[]) => void) {
  let use = noAgentUse;
  const connection = owner.connectionState();
  const ask = () => {
    if (connection.getSnapshot() !== "ready") return;
    try {
      owner.send({ type: "browser.browsing.watch", requestId: host.uuid() });
      owner.send({ type: "computer.using.watch", requestId: host.uuid() });
    } catch {
      // A daemon without these reports draws no marks; the next connection asks again.
    }
  };
  const stops = [
    owner.onMessage((message) => {
      const read = readAgentUse(use, message);
      if (!read) return;
      use = read.next;
      if (read.changed.length) changed(read.changed);
    }),
    connection.subscribe(ask),
  ];
  ask();
  return {
    current: () => use,
    stop: () => {
      for (const stop of stops) stop();
    },
  };
}
