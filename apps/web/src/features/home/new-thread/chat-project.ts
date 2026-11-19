import { useClient, useConnectionGeneration } from "@ace/client-react";
import type { KeyValueStorage } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { daemonErrorCode, refusalMessage } from "@/lib/daemon-command.ts";
import { rememberProject } from "@/lib/project-cache.ts";
import { useProjectDirectory, useThreadProjects } from "@/lib/projects.ts";

export { chatChoice } from "@/lib/chat-choice.ts";

const unusedKey = "ace.newThread.chatProject";
/** Failures of the connection, not refusals: the page says to check it and try again. */
const connectionCodes = new Set(["offline", "timeout", "aborted", "not_dispatched", "unknown"]);

/** The chat project made for New thread and not yet started in, if any. */
function unused(storage: KeyValueStorage | undefined): string | undefined {
  try {
    return storage?.getItem(unusedKey) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A message started in the chat project: the next chat gets its own. */
export function forgetChatProject(storage: KeyValueStorage | undefined, id: string): void {
  try {
    if (unused(storage) === id) storage?.removeItem?.(unusedKey);
  } catch {
    /* The next chat reuses it only while it has no thread. */
  }
}

export type ChatProject =
  | { state: "idle" | "making" }
  | { state: "ready"; project: string }
  | { state: "failed"; reason: string | undefined; retry(): void };

/**
 * The hidden project a chat from New thread starts in, while `wanted`. The one made earlier is
 * reused while the daemon still lists it and nothing started in it; otherwise the daemon makes
 * a fresh one. Opening New thread and leaving makes at most one, which the daemon removes later.
 * A failure keeps the daemon's reason, and a reconnect tries again on its own: a request lost to
 * a dropped socket is not the person's to retry.
 */
export function useChatProject(wanted: boolean, storage: KeyValueStorage | undefined): ChatProject {
  const client = useClient();
  const queries = useQueryClient();
  const directory = useProjectDirectory();
  const started = useThreadProjects();
  const [made, setMade] = useState<string>();
  const [failed, setFailed] = useState<{ reason: string | undefined }>();
  const generation = useConnectionGeneration();
  const making = useRef(false);
  // The one just made is used as it is: a device that may start threads but not see the project
  // list never hears of it there. One kept from an earlier visit is reused while the list still
  // has it and nothing started in it.
  const saved = unused(storage);
  const reusable =
    made ??
    (saved !== undefined && directory.isChat(saved) && !started.includes(saved)
      ? saved
      : undefined);
  const make = useCallback(() => {
    if (making.current) return;
    making.current = true;
    setFailed(undefined);
    client.projects.chat().then(
      (receipt) => {
        making.current = false;
        const project = receipt.ok ? receipt.workspace : undefined;
        if (!project) {
          setFailed({
            reason:
              receipt.detail ??
              receipt.title ??
              (receipt.error ? refusalMessage(receipt.error) : undefined),
          });
          return;
        }
        rememberProject(queries, project);
        try {
          storage?.setItem(unusedKey, project.id);
        } catch {
          /* Kept for this page only. */
        }
        setMade(project.id);
      },
      (error: unknown) => {
        making.current = false;
        // A refusal says why in words, never its raw code; a lost connection says to check it.
        const code = daemonErrorCode(error);
        setFailed({ reason: connectionCodes.has(code) ? undefined : refusalMessage(code) });
      },
    );
  }, [client, queries, storage]);
  const needed = wanted && directory.loaded && reusable === undefined && !failed;
  useEffect(() => {
    if (needed) make();
  }, [needed, make]);
  // A new socket: a chat that failed on the old one is asked for again.
  const seen = useRef(generation);
  useEffect(() => {
    if (seen.current === generation) return;
    seen.current = generation;
    if (failed && wanted) make();
  }, [generation, failed, wanted, make]);
  if (!wanted) return { state: "idle" };
  if (reusable) return { state: "ready", project: reusable };
  if (failed) return { state: "failed", reason: failed.reason, retry: make };
  return { state: "making" };
}
