import { Link, useRouterState } from "@tanstack/react-router";
import { ChatsCircleIcon, FoldersIcon, GearSixIcon } from "@phosphor-icons/react";
import type { PlaceSignal } from "@ace/ui-core";
import { useState, type ReactNode } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { railDotClass, railPlaceClass } from "@/components/rail-place.ts";
import { SpadeMark } from "@/components/spade-mark.tsx";
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
        // The link marks itself current when it points at the open page: only an exact match,
        // so Threads' last New thread never claims New chat's.
        activeOptions={exactMatch}
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
 * folders glyph: it lists projects), Chats (the speech bubbles) and Spade (not live yet), a short hairline, then
 * Code review, Automations and Skills; Settings, the app's update when there is one, and the profile
 * at the foot. The current place takes the active fill: Chats while a chat is open, Threads for
 * any other thread. Off Threads or Chats, a dot on its glyph says one of its own threads waits.
 */
export function AppRail(props: {
  /** Code review's place, which knows its own counts; current while one of its pages is open. */
  forge?: ((current: boolean) => ReactNode) | undefined;
}) {
  const current = useRailPlace();
  const signals = usePlaceSignals();
  const threads = useLastPlace(current === "home", "/new");
  const chats = useLastPlace(current === "chats", "/chats");
  return (
    <nav
      aria-label="App"
      data-slot="rail"
      className="flex w-(--rail-width) shrink-0 flex-col items-center gap-1 pt-0.5 pb-2.5"
    >
      <TooltipSide value="right">
        <ThreadPlace
          label="Threads"
          icon={FoldersIcon}
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
        <SpadeSoon />
        <span aria-hidden className="my-1.5 h-px w-5 shrink-0 bg-border" />
        {props.forge?.(current === "forge")}
        {railViews.map((view) => (
          <Tip key={view.id} label={view.label} {...(view.shortcut && { shortcut: view.shortcut })}>
            <Link
              to={view.to}
              aria-label={view.label}
              aria-current={current === view.id ? "page" : undefined}
              className={railPlaceClass}
            >
              <Icon icon={view.icon} size={20} active={current === view.id} />
            </Link>
          </Tip>
        ))}
        <span className="flex-1" />
        <UpdateButton />
        <Tip label="Settings" shortcut="settings">
          <Link
            to="/settings"
            aria-label="Settings"
            aria-current={current === "settings" ? "page" : undefined}
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

/**
 * Spade, ace's cloud agent, before it launches: its mark dimmed, "Coming soon" in its tooltip.
 * It is a picture, not a control: nothing to press or tab to.
 */
function SpadeSoon() {
  return (
    <Tip label="Spade · Coming soon">
      <span
        role="img"
        aria-label="Spade, coming soon"
        data-slot="spade-soon"
        className="grid size-10 shrink-0 cursor-default place-items-center text-muted-foreground"
      >
        <SpadeMark size={20} className="opacity-50" />
      </span>
    </Tip>
  );
}
