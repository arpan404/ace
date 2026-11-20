import { useMutation } from "@tanstack/react-query";
import { launchEditor, opensHere, type LaunchTarget } from "@/boot/editor-launch.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useEditors } from "./editors.ts";
import { useHostOpen, type HostOpenTarget } from "./host-open.ts";

/**
 * Shared editor preference, handoff and feedback for projects and threads. An editor this device
 * can't open itself (`opensHere`) opens through the daemon at `host`, the same folder by id.
 */
export function useEditorLaunch(
  resolve: (editorId: string) => Promise<LaunchTarget>,
  host?: HostOpenTarget,
) {
  const toast = useToast();
  const { choose } = useEditors();
  const machine = useHostOpen();
  return useMutation({
    mutationFn: async (editorId: string) => {
      if (host && !opensHere(editorId)) {
        // host.open toasts its own refusal; a failed open must not become the default.
        if (!(await machine.open(host, editorId))) return undefined;
        return { editorId };
      }
      const target = await resolve(editorId);
      await launchEditor(target);
      return target;
    },
    // The editor coming forward is the confirmation.
    onSuccess: (target) => {
      if (target) choose(target.editorId);
    },
    onError: (failure) =>
      toast.error({ title: "Couldn't open the editor", description: failure.message }),
  });
}
