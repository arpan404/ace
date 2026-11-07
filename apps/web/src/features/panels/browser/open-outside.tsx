import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openExternal, openExternalWhenReady } from "@/boot/open-external.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { toolbarButton } from "./page-toolbar.tsx";

/** The address a page can be opened at outside ace: http and https only. */
export function outsideAddress(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/**
 * Opens an address in this device's own browser, and says so when that fails. With `address`,
 * what opens is asked for at the call (a preview's fresh sign-in link).
 */
export function useOpenOutside(): (url: string, address?: () => Promise<string>) => void {
  const toast = useToast();
  return (url, address) =>
    void (address ? openExternalWhenReady(address()) : openExternal(url)).catch((error: unknown) =>
      toast.error({
        title: "Couldn't open the page",
        description: error instanceof Error ? error.message : undefined,
      }),
    );
}

/**
 * The toolbar's "Open in your browser": the address, with its path, query and fragment, in
 * this device's own browser. With `address`, what opens is asked for on the click, and `url`
 * is only what the button names.
 */
export function OpenOutside(props: { url: string; address?: (() => Promise<string>) | undefined }) {
  const open = useOpenOutside();
  return (
    <IconButton
      icon={ArrowSquareOutIcon}
      label="Open in your browser"
      className={toolbarButton}
      onClick={() => open(props.url, props.address)}
    />
  );
}
