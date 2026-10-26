import { useClient } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { launchEditor } from "@/boot/editor-launch.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useEditors } from "./editors.ts";

/**
 * Opening a file of a thread's checkout in an editor on the daemon's machine, at a line: the
 * device's chosen editor unless another is named, which then becomes the choice. Shared by the
 * Files and Changes tools.
 */
export function useOpenInEditor(threadId: string) {
  const client = useClient();
  const toast = useToast();
  const { editors, current, choose, unavailable } = useEditors();
  const open = async (path: string, line?: number, editorId = current?.id) => {
    if (!editorId) return;
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
