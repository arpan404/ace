import { useClient } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { launchEditor } from "@/boot/editor-launch.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useEditors } from "./editors.ts";
import { hostPathLike, useHostOpen, useRemoteHost } from "./host-open.ts";
import { resolveRootPath } from "./project-roots.ts";

/**
 * Opening a file of a thread's checkout in an editor on the daemon's machine, at a line: the
 * device's chosen editor unless another is named, which then becomes the choice. Shared by the
 * Files and Changes tools, the file viewer and transcript paths. An absolute path (or one from
 * `~`) opens by that host path instead of the checkout. On another machine the daemon opens it
 * there (`host.open`, toasting when only the owner can); here it opens through this device.
 */
export function useOpenInEditor(threadId: string) {
  const client = useClient();
  const toast = useToast();
  const { editors, current, choose, unavailable } = useEditors();
  const remote = useRemoteHost();
  const host = useHostOpen();
  const open = async (path: string, line?: number, editorId = current?.id) => {
    if (!editorId) return;
    // Another machine's file: the daemon opens it there and says when only the owner can.
    if (remote) {
      const target = hostPathLike(path) ? { hostPath: path } : { threadId, path };
      if (await host.open(target, editorId, line)) choose(editorId);
      return;
    }
    // A path of this machine outside the checkout: open it by itself, still only in an editor.
    if (hostPathLike(path)) {
      const editor = editors?.find((entry) => entry.id === editorId);
      if (!editor) return;
      try {
        await launchEditor({
          editorId: editor.id,
          editorName: editor.name,
          path: await resolveRootPath(client, path),
          line,
          command: editor.command,
        });
        choose(editor.id);
      } catch {
        toast.error({
          title: "Couldn't open the editor",
          description: `Check that ${editor.name} is installed, then try again.`,
        });
      }
      return;
    }
    try {
      const result = await client.command({
        type: "workspace.editor.open",
        threadId: ThreadId.parse(threadId),
        editorId,
      });
      if (!result.ok || !result.editor) throw new Error(result.error ?? "editor_failed");
      const root = result.editor.path.replace(/\/$/, "");
      await launchEditor({
        editorId: result.editor.editor.id,
        editorName: result.editor.editor.name,
        path: `${root}/${path}`,
        line,
        command: result.editor.editor.command,
      });
      choose(result.editor.editor.id);
    } catch {
      toast.error({
        title: "Couldn't open the editor",
        description:
          "Check that the editor is installed on the checkout's computer, then try again.",
      });
    }
  };
  return { editors, editor: current, unavailable, open };
}
