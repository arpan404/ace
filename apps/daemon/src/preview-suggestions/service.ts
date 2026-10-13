import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { discoverListeners, processCwds, processParents } from "@ace/preview/detection";
import type { TerminalAttachment } from "@ace/terminal";
import type { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { WorkspaceRuntime } from "../workspace-runtime.ts";
import { probePage } from "./page-probe.ts";
import { SuggestionTracker, type SuggestionIo, type SuggestionTrackerOptions } from "./tracker.ts";

/*
 * The daemon's side of dev server suggestions: a thread's scope is its project and worktree
 * roots plus its terminal shells, and its printed output comes from its terminals and from
 * agent shell output (`item.delta` on the `output` field).
 */

export interface SuggestionHost {
  store: Store;
  /** The workspace runtime once it has started. */
  runtime(): WorkspaceRuntime | undefined;
  now(): number;
  daemonPorts(): ReadonlySet<number>;
  onError?(error: unknown): void;
}

const realRoot = async (path: string) => realpath(path).catch(() => path);

function follow(host: SuggestionHost, threadId: ThreadId, feed: (s: string, c: string) => void) {
  const attachments = new Map<string, TerminalAttachment>();
  const runtime = host.runtime();
  const attach = (terminalId: string) => {
    if (!runtime || attachments.has(terminalId)) return;
    try {
      const terminal = runtime.terminal(terminalId, threadId);
      // From the oldest retained output, so an address printed just before still counts.
      const attachment = terminal.attach({ fromOffset: terminal.info().oldestOffset });
      attachments.set(terminalId, attachment);
      void (async () => {
        for await (const event of attachment)
          if (event.type === "data") feed(`terminal:${terminalId}`, event.data);
      })()
        .catch(() => {})
        .finally(() => attachments.delete(terminalId));
    } catch {
      // A terminal that closed meanwhile has nothing to scan.
    }
  };
  try {
    for (const terminal of runtime?.listTerminals(threadId) ?? [])
      if (!terminal.exited) attach(terminal.id);
  } catch {
    // The thread's workspace is gone; its terminals went with it.
  }
  const stopOpened = runtime?.onTerminalOpened((owner, terminalId) => {
    if (owner === threadId) attach(terminalId);
  });
  const stopShells = host.store.subscribe((events) => {
    for (const event of events)
      if (
        event.threadId === threadId &&
        event.payload.type === "item.delta" &&
        event.payload.field === "output"
      )
        feed(`item:${event.payload.itemId}`, event.payload.append);
  });
  return () => {
    stopOpened?.();
    stopShells();
    for (const attachment of attachments.values()) attachment.detach();
    attachments.clear();
  };
}

export function suggestionIo(host: SuggestionHost): SuggestionIo {
  return {
    listeners: () => discoverListeners(),
    parents: () => processParents(),
    cwds: (pids) => processCwds(pids),
    probe: (port) => probePage(port),
    async scope(threadId) {
      const thread = host.store.getThread(threadId);
      if (!thread || thread.deletedAt !== undefined) return undefined;
      const runtime = host.runtime();
      const paths = new Set<string>();
      const project = host.store.getWorkspacePath(thread.workspaceId);
      if (project) paths.add(project);
      let shells: number[] = [];
      try {
        if (runtime) {
          paths.add(runtime.root(thread.id));
          shells = runtime
            .listTerminals(thread.id)
            .filter((terminal) => !terminal.exited)
            .map((terminal) => terminal.pid);
        }
      } catch {
        // No worktree yet: the project root stands alone.
      }
      return { threadId, roots: await Promise.all([...paths].map(realRoot)), shells };
    },
    follow: (threadId, feed) => follow(host, threadId, feed),
  };
}

export function createPreviewSuggestions(
  host: SuggestionHost,
  overrides: Partial<Omit<SuggestionTrackerOptions, "io">> & { io?: Partial<SuggestionIo> } = {},
): SuggestionTracker {
  const { io, ...rest } = overrides;
  return new SuggestionTracker({
    now: host.now,
    wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal, ref: false }),
    daemon: process.pid,
    daemonPorts: host.daemonPorts,
    ...(host.onError ? { onError: host.onError } : {}),
    ...rest,
    io: { ...suggestionIo(host), ...io },
  });
}
