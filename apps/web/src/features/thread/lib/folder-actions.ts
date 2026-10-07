import { revealer } from "@/boot/open-external.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { keyboardEnv } from "@/lib/keybindings.ts";

/**
 * What can be done with a thread's folder from this device: copy its path, and show it in the
 * file manager (the desktop app only; a browser can't reach this computer's folders).
 */
export function useFolderActions(path: string | undefined): {
  copy: (() => void) | undefined;
  reveal: (() => void) | undefined;
  revealLabel: string;
  /** Why it can't be shown, when it can't. */
  revealReason: string | undefined;
} {
  const toast = useToast();
  const show = revealer();
  return {
    copy: path
      ? () =>
          void navigator.clipboard?.writeText(path).then(
            () => toast.add({ title: "Path copied" }),
            () => toast.error({ title: "Couldn't copy the path" }),
          )
      : undefined,
    reveal:
      show && path
        ? () => void show(path).catch(() => toast.error({ title: `Couldn't open ${path}` }))
        : undefined,
    revealLabel: keyboardEnv().apple ? "Show in Finder" : "Show in folder",
    revealReason: !show
      ? "In the desktop app"
      : path
        ? undefined
        : "The daemon hasn't said where the checkout is",
  };
}
