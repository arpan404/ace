import { useMutation } from "@tanstack/react-query";
import { launchEditor, type LaunchTarget } from "@/boot/editor-launch.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useEditors } from "./editors.ts";

/** Shared editor preference, handoff and feedback for projects and threads. */
export function useEditorLaunch(resolve: (editorId: string) => Promise<LaunchTarget>) {
  const toast = useToast();
  const { choose } = useEditors();
  return useMutation({
    mutationFn: async (editorId: string) => {
      const target = await resolve(editorId);
      await launchEditor(target);
      return target;
    },
    onSuccess: (target) => {
      choose(target.editorId);
      toast.add({ title: `Opened in ${target.editorName}` });
    },
    onError: (failure) =>
      toast.error({ title: "Couldn't open the editor", description: failure.message }),
  });
}
