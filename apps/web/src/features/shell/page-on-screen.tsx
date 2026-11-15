import type { SuitPage } from "@ace/protocol/suit-parts";
import {
  createContext,
  useContext,
  useLayoutEffect,
  type Dispatch,
  type SetStateAction,
} from "react";

/*
 * The Suit page on screen (`data-page`, docs/design/suit-parts.md). The routed screen names its
 * own page, which may be finer than its route's (a thread that is a chat says `chat`); the shell
 * puts it on the `app` part, falling back to the route's page while no screen has said.
 */

type SetPage = Dispatch<SetStateAction<SuitPage | undefined>>;

export const PageOnScreenContext = createContext<SetPage | undefined>(undefined);

/** Tells the shell this screen's page while it is mounted. */
export function useAnnouncePage(page: SuitPage | undefined): void {
  const setPage = useContext(PageOnScreenContext);
  useLayoutEffect(() => {
    if (!setPage || !page) return;
    setPage(page);
    return () => setPage((shown) => (shown === page ? undefined : shown));
  }, [setPage, page]);
}

/** `part("page")` with its `data-page`, or nothing for a screen that names no page. */
export function pageAttributes(page: SuitPage | undefined): {
  "data-part"?: "page";
  "data-page"?: SuitPage;
} {
  return page ? { "data-part": "page", "data-page": page } : {};
}
