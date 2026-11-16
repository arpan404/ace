import { Link, useRouterState } from "@tanstack/react-router";
import { ChatsCircleIcon, FolderSimpleIcon, GearSixIcon } from "@ace/icons";
import type { PlaceSignal } from "@ace/ui-core";
import { useState, type ReactNode } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { railDotClass, railPlaceClass } from "@/components/rail-place.ts";
import { SpadeMark } from "@/components/spade-mark.tsx";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";
import { useSpadeShown } from "@/lib/spade-available.ts";
import { Tip, TooltipSide } from "@/components/ui/tooltip.tsx";
import { AccountMenu } from "./account-menu.tsx";
import { UpdateButton } from "./update-button.tsx";
import { usePlaceSignals } from "./use-place-signals.ts";
import { useRailPlace } from "./use-rail-place.ts";
import { railViews } from "./views.ts";

/**
 * Where a place goes: the page (a thread, or New thread with its search) the person last had
 * open there, so coming back from Settings or Code review lands where they left; `start` before they
 * have been there.
 */
function useLastPlace(here: boolean, start: string): Place {
  const location = useRouterState({ select: (state) => state.location });
  const [last, setLast] = useState({ href: start, to: start, search: {} });
  if (here && location.href !== last.href)
    setLast({ href: location.href, to: location.pathname, search: location.search });
  return last;
}

interface Place {
  href: string;
  to: string;
  search: object;
}

const exactMatch = { exact: true, includeSearch: true } as const;

const needWord = (count: number) => `${count} ${count === 1 ? "needs" : "need"} you`;

/**
 * Threads or Chats in the rail: its glyph (filled while current) and, while it isn't current, a
 * dot when one of its own threads waits on the person (or has news not yet seen).
 */
function ThreadPlace(props: {
  label: string;
  icon: IconGlyph;
  shortcut: "goHome" | "goChats";
  current: boolean;
  /** Where it goes (`useLastPlace`), read in the same render as `current`. */
  last: Place;
  signal: PlaceSignal;
}) {
  const { signal, last } = props;
  const tone = props.current ? undefined : signal.tone;
  const asks = tone === "needs-you" ? ` · ${needWord(signal.needsYou)}` : "";
  return (
    <Tip label={`${props.label}${asks}`} shortcut={props.shortcut}>
      <Link
        to={last.to}
        search={last.search}
        aria-label={`${props.label}${asks.replace(" ·", ",")}`}
        aria-current={props.current ? "page" : undefined}
        data-state={props.current ? "active" : undefined}
        // The link marks itself current when it points at the open page: only an exact match,
        // so Threads' last New thread never claims New chat's.
        activeOptions={exactMatch}
        data-part="rail-item"
        className={railPlaceClass}
      >
        <Icon icon={props.icon} size={20} active={props.current} />
        {tone && <span aria-hidden data-tone={tone} className={railDotClass} />}
      </Link>
    </Tip>
  );
}

/**
 * The sidebar's rail, under the window's top bar: the app's places as bare glyphs, Threads (the
 * folders glyph: it lists projects), Chats (the speech bubbles) and Spade (its mark), a short hairline, then
 * Code review, Automations and Skills; the app's update when there is one, Usage, Settings and the
 * profile at the foot. The current place takes the active fill: Chats while a chat is open, Threads for
 * any other thread. Off Threads or Chats, a dot on its glyph says one of its own threads waits.
 */
export function AppRail(props: {
  /** Code review's place, which knows its own counts; current while one of its pages is open. */
  forge?: ((current: boolean) => ReactNode) | undefined;
  /** Usage's place in the foot, its bars and card; current while the Usage page is open. */
  usage?: ((current: boolean) => ReactNode) | undefined;
  /** Spade's place, which knows when an approval waits; where it goes is the rail's. */
  spade?: ((current: boolean, to: string, search: object) => ReactNode) | undefined;
  /** The Marketplace, under Skills: a button that opens its modal over the page. */
  market?: ReactNode;
  /** A Suit merged the rail into the sidebar: its places run as a row along the panel's top. */
  merged?: boolean | undefined;
}) {
  const merged = props.merged === true;
  const current = useRailPlace();
  const signals = usePlaceSignals();
  const threads = useLastPlace(current === "home", "/new");
  const chats = useLastPlace(current === "chats", "/chats");
  const spade = useLastPlace(current === "spade", "/spade");
  // Until the daemon says, the mark stays as coming soon: Spade is hidden by default.
  const spadeShown = useSpadeShown() === true;
  // Off in Settings › Beta (the default), the Marketplace has no place in the rail.
  const marketplace = useBetaEnabled("marketplace") === true;
  return (
    <nav
      aria-label="App"
      data-slot="rail"
      data-part="rail"
      data-variant={merged ? "merged" : undefined}
      className={
        merged
          ? "no-scrollbar flex h-11 shrink-0 items-center gap-1 overflow-x-auto px-2"
          : "flex w-(--rail-width) shrink-0 flex-col items-center gap-1 pt-0.5 pb-2.5"
      }
    >
      <TooltipSide value={merged ? "bottom" : "right"}>
        <ThreadPlace
          label="Projects"
          icon={FolderSimpleIcon}
          shortcut="goHome"
          current={current === "home"}
          last={threads}
          signal={signals.threads}
        />
        <ThreadPlace
          label="Chats"
          icon={ChatsCircleIcon}
          shortcut="goChats"
          current={current === "chats"}
          last={chats}
          signal={signals.chats}
        />
        {spadeShown ? (
          (props.spade?.(current === "spade", spade.to, spade.search) ?? (
            <SpadePlace current={current === "spade"} last={spade} />
          ))
        ) : (
          <SpadeComingSoon />
        )}
        <span
          aria-hidden
          className={
            merged ? "mx-1.5 h-5 w-px shrink-0 bg-border" : "my-1.5 h-px w-5 shrink-0 bg-border"
          }
        />
        {props.forge?.(current === "forge")}
        {railViews.map((view) => (
          <Tip key={view.id} label={view.label} {...(view.shortcut && { shortcut: view.shortcut })}>
            <Link
              to={view.to}
              aria-label={view.label}
              aria-current={current === view.id ? "page" : undefined}
              data-state={current === view.id ? "active" : undefined}
              data-part="rail-item"
              className={railPlaceClass}
            >
              <Icon icon={view.icon} size={20} active={current === view.id} />
            </Link>
          </Tip>
        ))}
        {marketplace && props.market}
        <span className="flex-1" />
        <UpdateButton />
        {props.usage?.(current === "usage")}
        <Tip label="Settings" shortcut="settings">
          <Link
            to="/settings"
            aria-label="Settings"
            aria-current={current === "settings" ? "page" : undefined}
            data-state={current === "settings" ? "active" : undefined}
            data-part="rail-item"
            className={railPlaceClass}
          >
            <Icon icon={GearSixIcon} size={20} active={current === "settings"} />
          </Link>
        </Tip>
        <AccountMenu />
      </TooltipSide>
    </nav>
  );
}

/** Spade in a build without it: its mark, which goes nowhere yet. */
export function SpadeComingSoon() {
  return (
    <Tip label="Spade · Coming soon">
      <span
        role="img"
        aria-label="Spade, coming soon"
        data-part="rail-item"
        className={`${railPlaceClass} cursor-default`}
      >
        <SpadeMark size={20} />
      </span>
    </Tip>
  );
}

/**
 * Spade, ace's assistant, while its own place (`spade`, with its signal) isn't there: its mark,
 * back to where the person last was in Spade.
 */
export function SpadePlace(props: { current: boolean; last: Pick<Place, "to" | "search"> }) {
  return (
    <Tip label="Spade">
      <Link
        to={props.last.to}
        search={props.last.search}
        aria-label="Spade"
        aria-current={props.current ? "page" : undefined}
        data-state={props.current ? "active" : undefined}
        data-part="rail-item"
        className={railPlaceClass}
      >
        <SpadeMark size={20} />
      </Link>
    </Tip>
  );
}
