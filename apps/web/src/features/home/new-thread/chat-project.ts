import { useClient } from "@ace/client-react";
import type { KeyValueStorage } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { rememberProject } from "@/lib/project-cache.ts";
import { useProjectDirectory, useThreadProjects } from "@/lib/projects.ts";

export { chatChoice } from "@/lib/chat-choice.ts";

const unusedKey = "ace.newThread.chatProject";

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
  | { state: "failed"; retry(): void };

/**
 * The hidden project a chat from New thread starts in, while `wanted`. The one made earlier is
 * reused while the daemon still lists it and nothing started in it; otherwise the daemon makes
 * a fresh one. Opening New thread and leaving makes at most one, which the daemon removes later.
 */
export function useChatProject(wanted: boolean, storage: KeyValueStorage | undefined): ChatProject {
  const client = useClient();
  const queries = useQueryClient();
  const directory = useProjectDirectory();
  const started = useThreadProjects();
  const [made, setMade] = useState<string>();
  const [failed, setFailed] = useState(false);
  const making = useRef(false);
  const saved = made ?? unused(storage);
  const reusable =
    saved !== undefined && directory.isChat(saved) && !started.includes(saved) ? saved : undefined;
  const make = useCallback(() => {
    if (making.current) return;
    making.current = true;
    setFailed(false);
    client.projects.chat().then(
      (receipt) => {
        making.current = false;
        const project = receipt.ok ? receipt.workspace : undefined;
        if (!project) {
          setFailed(true);
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
      () => {
        making.current = false;
        setFailed(true);
      },
    );
  }, [client, queries, storage]);
  const needed = wanted && directory.loaded && reusable === undefined && !failed;
  useEffect(() => {
    if (needed) make();
  }, [needed, make]);
  if (!wanted) return { state: "idle" };
  if (reusable) return { state: "ready", project: reusable };
  if (failed) return { state: "failed", retry: make };
  return { state: "making" };
}
