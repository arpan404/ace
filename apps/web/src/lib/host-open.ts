import { useClient } from "@ace/client-react";
import { ThreadId, WorkspaceId, type SkillEntry } from "@ace/protocol";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useScopedMachine } from "./machines.ts";
import { useEditors } from "./editors.ts";

/*
 * Opening on the daemon's own machine (`workspace.request` `host.open`): a thread's or
 * project's folder, a file in it, or any host path, in an installed editor or the file manager.
 * The daemon opens or reveals the resolved target only — never runs it — and decides who may
 * ask: inside a project or a personal skill folder needs `operate`, anywhere else the owner's
 * `admin` (answered `owner_only`). The local fast path (URL handler, desktop bridge) stays in
 * `open-in-editor.ts` and `skill-file-actions.ts`; this is what a remote machine opens through.
 */

/** Where to open: a thread's or project's folder (a file in it), or any path on the machine. */
export type HostOpenTarget =
  | { threadId: string; path?: string | undefined }
  | { workspaceId: string; path?: string | undefined }
  | { hostPath: string };

/** Absolute (POSIX or a Windows drive) or from the home folder: a path of the machine itself. */
export function hostPathLike(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Where Open on computer opens a skill: its SKILL.md in a project, or by its own host path for a
 * personal skill. Null for a plugin skill (no folder of its own) and a builtin (ace's install,
 * which only the machine's owner opens). Mirrors the phone's `skill-host-open.ts`.
 */
export function skillHostOpenTarget(
  entry: Pick<SkillEntry, "scope" | "path">,
  workspaceId: string | undefined,
): { workspaceId: string; path: string } | { hostPath: string } | null {
  const file = `${entry.path.replace(/[\\/]+$/, "")}/SKILL.md`;
  if (entry.scope === "project") return workspaceId ? { workspaceId, path: file } : null;
  if (entry.scope === "plugin") return null;
  return hostPathLike(entry.path) ? { hostPath: file } : null;
}

/** Where Show in folder shows a skill: its own folder, by project or by host path. */
export function skillHostFolderTarget(
  entry: Pick<SkillEntry, "scope" | "path">,
  workspaceId: string | undefined,
): { workspaceId: string; path: string } | { hostPath: string } | null {
  if (entry.scope === "project") return workspaceId ? { workspaceId, path: entry.path } : null;
  if (entry.scope === "personal") return hostPathLike(entry.path) ? { hostPath: entry.path } : null;
  return null;
}

/**
 * Whether the daemon's files are on another machine: a scoped Fleet machine, or a daemon reached
 * over the network. Its folders open through `host.open`, not this device's editor handler.
 */
export function useRemoteHost(): boolean {
  const scoped = useScopedMachine();
  const connection = useDaemonConnection();
  if (scoped && !scoped.primary) return true;
  if (connection.mode !== "daemon") return false;
  try {
    const host = new URL(connection.url).hostname;
    return host !== "" && host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]";
  } catch {
    return false;
  }
}

/** Refusal codes `host.open` answers with, in words. */
function refusalText(code: string): { title: string; description?: string } {
  switch (code) {
    case "owner_only":
      return { title: "Only the machine's owner can open this." };
    case "forbidden":
      return {
        title: "Couldn't open that on the machine",
        description: "You need operate access to open files there.",
      };
    case "workspace_not_found":
      return { title: "That project is gone." };
    case "path_not_found":
      return { title: "That isn't on the machine any more." };
    case "path_not_openable":
      return { title: "That isn't a file or folder ace can open." };
    case "editor_not_found":
      return {
        title: "Couldn't open the editor",
        description: "That editor isn't installed on that computer any more.",
      };
    default:
      return {
        title: "Couldn't open that on the machine",
        description: "Check the connection and try again.",
      };
  }
}

/**
 * Open on the daemon's machine, in its editor or file manager: `open` for a file or folder in an
 * editor, `reveal` to show it in the file manager. Failures toast (an `owner_only` path says only
 * the owner can); the editor coming forward on that machine is the confirmation.
 */
export function useHostOpen(): {
  editors: ReturnType<typeof useEditors>["editors"];
  editor: ReturnType<typeof useEditors>["current"];
  unavailable: string | undefined;
  /** The daemon machine's file manager by name ("Finder"), for the reveal label. */
  fileManager: string | undefined;
  open(target: HostOpenTarget, editorId?: string, line?: number): Promise<boolean>;
  reveal(target: HostOpenTarget): Promise<boolean>;
} {
  const client = useClient();
  const toast = useToast();
  const { editors, current, unavailable, fileManager } = useEditors();
  const run = async (
    target: HostOpenTarget,
    app: { kind: "editor"; editorId: string } | { kind: "files" },
    line?: number,
  ): Promise<boolean> => {
    const operation = {
      op: "host.open",
      app,
      ...("threadId" in target
        ? {
            threadId: ThreadId.parse(target.threadId),
            ...(target.path ? { path: target.path } : {}),
          }
        : "workspaceId" in target
          ? {
              workspaceId: WorkspaceId.parse(target.workspaceId),
              ...(target.path ? { path: target.path } : {}),
            }
          : { hostPath: target.hostPath }),
      ...(line ? { line } : {}),
    } as const;
    let code: string | undefined;
    try {
      const reply = await client.request({ type: "workspace.request", operation });
      const result = reply.result;
      if (result.kind === "opened") return true;
      code = result.kind === "error" ? result.code : "unavailable";
    } catch {
      code = "unavailable";
    }
    const words = refusalText(code);
    toast.error(words);
    return false;
  };
  return {
    editors,
    editor: current,
    unavailable,
    fileManager,
    open: (target, editorId = current?.id, line) =>
      editorId ? run(target, { kind: "editor", editorId }, line) : Promise.resolve(false),
    reveal: (target) => run(target, { kind: "files" }),
  };
}
