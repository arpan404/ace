import { revealer } from "@/boot/open-external.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { keyboardEnv } from "@/lib/keybindings.ts";

/** Where "show" opens a file: Finder on a Mac, the file manager's folder elsewhere. */
export function revealWords(): {
  show: string;
  showFile(name: string): string;
  showFolder(name: string): string;
} {
  const apple = keyboardEnv().apple;
  return {
    show: apple ? "Show in Finder" : "Show in folder",
    showFile: (name) => (apple ? `Show ${name} in Finder` : `Show ${name} in its folder`),
    showFolder: (name) => (apple ? `Show ${name} in Finder` : `Open the ${name} folder`),
  };
}

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
          void navigator.clipboard
            ?.writeText(path)
            .catch(() => toast.error({ title: "Couldn't copy the path" }))
      : undefined,
    reveal:
      show && path
        ? () => void show(path).catch(() => toast.error({ title: `Couldn't open ${path}` }))
        : undefined,
    revealLabel: revealWords().show,
    revealReason: !show
      ? "In the desktop app"
      : path
        ? undefined
        : "ace hasn't said where the checkout is",
  };
}
