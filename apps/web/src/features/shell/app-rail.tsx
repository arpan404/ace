import { Link, useRouterState } from "@tanstack/react-router";
import { ChatsCircleIcon, GearSixIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { railDotClass, railPlaceClass } from "@/components/rail-place.ts";
import { SpadeMark } from "@/components/spade-mark.tsx";
import { Tip, TooltipSide } from "@/components/ui/tooltip.tsx";
import { AccountMenu } from "./account-menu.tsx";
import { UpdateButton } from "./update-button.tsx";
import { useNeedsYouCount } from "./use-needs-you-count.ts";
import { activeView, railViews } from "./views.ts";

/**
 * Where Threads goes: the thread (or New thread, with its search) the person last had open, so
 * coming back from Settings or GitHub lands where they left; New thread before they have been
 * on one.
 */
function useLastThreadsPlace(onThreads: boolean) {
  const location = useRouterState({ select: (state) => state.location });
  const [last, setLast] = useState({ href: "/new", to: "/new", search: {} });
  if (onThreads && location.href !== last.href)
    setLast({ href: location.href, to: location.pathname, search: location.search });
  return last;
}

const needWord = (count: number) => `${count} ${count === 1 ? "needs" : "need"} you`;

/**
 * The sidebar's rail: the app's places as bare glyphs, top to bottom Threads, Spade (not live
 * yet), GitHub, Automations and Skills; then Settings, the app's update when there is one, and
 * the profile at the foot. The current place takes the active fill. Off Threads, a dot on its
 * glyph says a thread waits on the person. Its top is the window's drag area, where macOS draws
 * the traffic lights.
 */
export function AppRail(props: {
  /** GitHub's place, which knows its own counts; current while one of its pages is open. */
  forge?: ((current: boolean) => ReactNode) | undefined;
}) {
  const current = useRouterState({ select: (state) => activeView(state.location.pathname) });
  const onThreads = current === "home";
  const threads = useLastThreadsPlace(onThreads);
  const waiting = useNeedsYouCount();
  const signal = !onThreads && waiting > 0;
  return (
    <nav
      aria-label="App"
      data-slot="rail"
      className="flex w-(--rail-width) shrink-0 flex-col items-center gap-1 pb-2.5"
    >
      <div aria-hidden className="h-(--header-h) w-full shrink-0 [-webkit-app-region:drag]" />
      <TooltipSide value="right">
        <Tip label={signal ? `Threads · ${needWord(waiting)}` : "Threads"} shortcut="goHome">
          <Link
            to={threads.to}
            search={threads.search}
            aria-label={signal ? `Threads, ${needWord(waiting)}` : "Threads"}
            aria-current={onThreads ? "page" : undefined}
            className={railPlaceClass}
          >
            <Icon icon={ChatsCircleIcon} size={18} active={onThreads} />
            {signal && <span aria-hidden data-tone="needs-you" className={railDotClass} />}
          </Link>
        </Tip>
        <SpadeSoon />
        {props.forge?.(current === "forge")}
        {railViews.map((view) => (
          <Tip key={view.id} label={view.label} {...(view.shortcut && { shortcut: view.shortcut })}>
            <Link
              to={view.to}
              aria-label={view.label}
              aria-current={current === view.id ? "page" : undefined}
              className={railPlaceClass}
            >
              <Icon icon={view.icon} size={18} active={current === view.id} />
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
            <Icon icon={GearSixIcon} size={18} active={current === "settings"} />
          </Link>
        </Tip>
        <AccountMenu />
      </TooltipSide>
    </nav>
  );
}

/**
 * Spade, ace's cloud agent, before it launches: its mark dimmed with a small Soon under it. It
 * is a picture, not a control: nothing to press or tab to, and hovering says it's coming.
 */
function SpadeSoon() {
  return (
    <Tip label="Spade · Coming soon">
      <span
        role="img"
        aria-label="Spade, coming soon"
        data-slot="spade-soon"
        className="relative mb-2 grid size-9 shrink-0 cursor-default place-items-center text-muted-foreground"
      >
        <SpadeMark size={20} className="opacity-60" />
        <span
          aria-hidden
          className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-border bg-sidebar px-1 py-px text-[8.5px] leading-none font-semibold tracking-[0.02em] whitespace-nowrap text-muted-foreground"
        >
          Soon
        </span>
      </span>
    </Tip>
  );
}
