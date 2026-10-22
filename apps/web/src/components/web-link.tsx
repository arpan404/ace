import {
  createContext,
  useCallback,
  useContext,
  type AnchorHTMLAttributes,
  type MouseEvent,
} from "react";
import { openExternal } from "@/boot/open-external.ts";
import { applePlatform } from "@/lib/keymap.ts";
import { linkDestination, type LinkClick } from "@/lib/web-links.ts";

/*
 * Links to web addresses. A screen with ace's browser (a thread's) provides `WebLinkOpener`;
 * `useOpenWebAddress` and `WebLink` then open addresses there, keeping the system's browser for
 * ⌘/Ctrl-click and middle click (rules: `lib/web-links.ts`). Without one they open in the
 * system's browser, as a plain link would.
 */

/** Opens an address in this screen's own browser; provided by a screen that has one. */
export const WebLinkOpener = createContext<((url: string) => void) | undefined>(undefined);

/**
 * Open a web address the way a link click would: `click` is the click that asked, when there
 * was one. Rejects when the system's browser couldn't be reached.
 */
export function useOpenWebAddress(): (url: string, click?: LinkClick) => Promise<void> {
  const inApp = useContext(WebLinkOpener);
  return useCallback(
    async (url: string, click?: LinkClick) => {
      const where = linkDestination({ url, click, apple: applePlatform, inApp: !!inApp });
      if (where === "app" && inApp) inApp(url);
      else await openExternal(url);
    },
    [inApp],
  );
}

const webAddress = (href: string | undefined): href is string =>
  !!href && /^https?:\/\//i.test(href);

/**
 * An `<a>` to a web address that opens through `useOpenWebAddress`. It stays a real link: its
 * address copies, and Shift- or Alt-click keep the browser's own meaning. A click handler that
 * calls `preventDefault` takes the click over.
 */
export function WebLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const { href, children, onClick, onAuxClick, ...rest } = props;
  const open = useOpenWebAddress();
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.shiftKey || event.altKey) return;
    if (!webAddress(href)) return;
    event.preventDefault();
    void open(href, event).catch(() => {});
  };
  return (
    <a
      target="_blank"
      rel="noreferrer noopener"
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.button === 0) follow(event);
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event);
        if (event.button === 1) follow(event);
      }}
    >
      {children}
    </a>
  );
}
