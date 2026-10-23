import { useEffect } from "react";
import { useCanGoBack, useRouter } from "@tanstack/react-router";

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Back from a PR or issue page to the list it was opened from: the same filters, sort and
 * search (the list's address, carried as `back`; a full path for another list, the inbox), and its scroll position, which the list keeps
 * itself. Opened from the list, it is the browser's own back; opened from a link, it opens the
 * list fresh. Escape does the same, unless something on the page takes it first.
 */
export function useBackToList(
  list: "/pulls" | "/issues",
  project: string,
  back: string | undefined,
) {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const go = () => {
    if (back !== undefined && canGoBack) router.history.back();
    // A full path names the list it came from (the inbox); a search names this list's.
    else if (back !== undefined)
      void router.navigate({ href: back.startsWith("/") ? back : `${list}${back}` });
    else void router.navigate({ to: list, search: { project } });
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || editable(event.target)) return;
      // A dialog or menu over the page takes its own Escape.
      if (document.querySelector("[role=dialog],[role=menu],[role=listbox]")) return;
      event.preventDefault();
      go();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  return go;
}

/** What Back names: the list a page came from, the inbox when opened from it. */
export function backLabel(back: string | undefined, list: string): string {
  return back?.startsWith("/inbox") ? "Inbox" : list;
}
