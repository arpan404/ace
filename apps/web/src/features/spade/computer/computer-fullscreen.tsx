import { spadeUsedSurfaces, type SpadeSurface } from "@ace/ui-core/spade-chat";
import { ArrowsInSimpleIcon } from "@ace/icons";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import type { RosterBot } from "../use-spade-roster.ts";
import { isOtherView, otherNames, OtherPane } from "./fullscreen-other.tsx";
import { driveWords } from "./drive-line.tsx";
import { AddressBar } from "./surface-picture.tsx";
import { BotTerminal } from "./bot-terminal.tsx";
import type { ProfileComputerPlace } from "./profile-computer.tsx";
import { SurfaceLive } from "./surface-live.tsx";
import { useBotPicture } from "./stream-picture.tsx";
import { ZoomFrame } from "./zoom-frame.tsx";

/** What the full-screen view switches between, in its order. */
export type FullView = "screen" | "browser" | "terminal";
const order: readonly FullView[] = ["screen", "browser", "terminal"];
const names: Record<FullView, string> = {
  screen: "Screen",
  browser: "Browser",
  terminal: "Terminal",
};

/** The views this bot's computer offers: what it used (and what a link asked for), and its terminal. */
export function fullViewsOf(place: ProfileComputerPlace, bot: RosterBot): FullView[] {
  const used = spadeUsedSurfaces(place.state.computer);
  const asked = place.view === "browser" || place.view === "screen" ? place.view : undefined;
  const offered = new Set<FullView>(["terminal"]);
  for (const kind of used) if (kind === "browser" || kind === "screen") offered.add(kind);
  if (asked) offered.add(asked);
  // A bot that never used a picture surface still shows its screen, which wakes on first use.
  if (offered.size === 1 && bot.computer?.state === "starting") offered.add("screen");
  return order.filter((kind) => offered.has(kind));
}

/**
 * The bot's computer over the whole window, on a plain dark ground (docs: computer.md). Opening
 * it shows "Switching to <bot>'s screen…" until a picture comes; then the surface, a quiet
 * switcher (Screen, Browser, Terminal), and zoom. Take over switches to exclusive mode, so the
 * person's pointer and keys go to the bot's screen or browser and their typing to its terminal;
 * Hand back gives it to the bot. Esc, or the collapse button, closes it.
 */
export function ComputerFullscreen(props: {
  bot: RosterBot;
  place: ProfileComputerPlace;
  onClose(): void;
}) {
  const { bot, place } = props;
  const { state } = place;
  const views = fullViewsOf(place, bot);
  const wanted = place.view === "browser" || place.view === "screen" || place.view === "terminal";
  const recent = (kind: FullView) =>
    state.computer?.surfaces.some((each) => each.kind === kind && each.live) === true;
  const view: FullView =
    wanted && views.includes(place.view as FullView)
      ? (place.view as FullView)
      : (views.find(recent) ?? views.find((kind) => kind !== "terminal") ?? "terminal");
  const driving = state.driving;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // While they drive, Esc belongs to the bot's screen or terminal; the button closes.
      if (event.key === "Escape" && !driving) {
        event.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [driving, props]);
  const other = isOtherView(place.view) ? place.view : undefined;
  const surface = state.computer?.surfaces.find((each) => each.kind === view);
  const label = `${bot.name}'s ${view}`;
  const words = driveWords(state, bot.name, other ? "computer" : view);
  const person = words.person;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${bot.name}'s computer`}
      className="dark fixed inset-0 z-[100] flex flex-col bg-[#141414] text-white"
    >
      <div className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-3">
        <div role="status" className="flex items-center gap-2 text-ui text-white/70">
          {words.text}
          {(words.busy || person) && (
            <button
              type="button"
              disabled={state.pending !== undefined}
              onClick={person ? state.handBack : state.takeOver}
              className="h-8 rounded-full bg-white/10 px-3 text-ui font-medium text-white focus-ring hover:bg-white/20 disabled:opacity-50"
            >
              {person ? "Hand back" : "Take over"}
            </button>
          )}
        </div>
        <div
          role="tablist"
          aria-label="Computer"
          className="flex items-center gap-0.5 rounded-full bg-white/8 p-0.5"
        >
          {views.map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={!other && kind === view}
              data-view={kind}
              onClick={() => place.onView(kind)}
              className={cn(
                "h-7 rounded-full px-3 text-ui focus-ring",
                !other && kind === view
                  ? "bg-white/15 font-medium text-white"
                  : "text-white/60 hover:text-white",
              )}
            >
              {names[kind]}
              {state.atWork && recent(kind) && <span className="sr-only">, in use</span>}
            </button>
          ))}
          {other && (
            <button
              type="button"
              role="tab"
              aria-selected
              data-view={other}
              className="h-7 rounded-full bg-white/15 px-3 text-ui font-medium text-white focus-ring"
            >
              {otherNames[other]}
            </button>
          )}
        </div>
        <div className="flex items-center justify-end gap-1">
          <IconButton
            icon={ArrowsInSimpleIcon}
            label="Collapse computer"
            tip="Collapse"
            className="text-white/80 hover:text-white"
            onClick={props.onClose}
          />
        </div>
      </div>
      {other ? (
        <OtherPane bot={bot} view={other} place={place} />
      ) : view === "terminal" ? (
        <div role="tabpanel" aria-label="Terminal" className="min-h-0 flex-1">
          <BotTerminal bot={bot} mayType={state.mayAct} />
        </div>
      ) : (
        <PictureView
          key={`${bot.machine.key}/${bot.id}/${view}`}
          bot={bot}
          kind={view}
          place={place}
          surface={surface}
          label={label}
          waking={state.computer?.state === "starting"}
        />
      )}
    </div>,
    document.body,
  );
}

/** A screen or browser, zoomable; until its first picture, the dots and "Switching to…". */
function PictureView(props: {
  bot: RosterBot;
  kind: "screen" | "browser";
  place: ProfileComputerPlace;
  surface: SpadeSurface | undefined;
  label: string;
  waking: boolean;
}) {
  const { bot, kind, place } = props;
  const { state } = place;
  const key = { machine: bot.machine.key, bot: bot.id, surface: kind } as const;
  const { picture, available } = useBotPicture(key);
  const connecting = props.waking || (available && !picture);
  return (
    <div role="tabpanel" aria-label={names[kind]} className="relative flex min-h-0 flex-1 flex-col">
      {kind === "browser" && <AddressBar url={props.surface?.url} />}
      <ZoomFrame
        acting={state.mayAct}
        native={() => (picture ? nativeScale(picture) : 1)}
        controlsClass="absolute right-3 bottom-3 z-10 rounded-full bg-black/60 p-0.5 backdrop-blur"
      >
        <SurfaceLive
          machine={bot.machine}
          bot={bot}
          kind={kind}
          surface={props.surface}
          threadId={state.computer?.threadId}
          mayAct={state.mayAct}
          driving={state.driving}
          label={props.label}
        />
      </ZoomFrame>
      {connecting && <Connecting name={bot.name} />}
    </div>
  );
}

/** The scale at which one picture pixel is one screen pixel, relative to the fitted picture. */
function nativeScale(picture: { width: number; height: number }) {
  const frame = document.querySelector("[data-zoom]")?.getBoundingClientRect();
  if (!frame || !frame.width || !frame.height) return 1;
  const fit = Math.min(frame.width / picture.width, frame.height / picture.height);
  return fit > 0 ? 1 / fit : 1;
}

/** Three dots and one line, centred on the plain ground. */
function Connecting(props: { name: string }) {
  return (
    <div
      role="status"
      className="absolute inset-0 z-20 grid place-content-center justify-items-center gap-6 bg-[#141414]"
    >
      <span aria-hidden className="flex items-center gap-1.5">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-2 animate-pulse rounded-full bg-white"
            style={{ animationDelay: `${dot * 180}ms` }}
          />
        ))}
      </span>
      <p className="text-ui text-white/50">
        <span className="text-white">Switching</span>
        {` to ${props.name}'s screen…`}
      </p>
    </div>
  );
}
