import {
  CaretRightIcon,
  EyeSlashIcon,
  GlobeSimpleIcon,
  MonitorIcon,
  TerminalWindowIcon,
} from "@ace/icons";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { SpadeFace } from "../spade-face.tsx";
import { ProfileCard, profileRowClass } from "../spade-profile-parts.tsx";
import type { RosterBot } from "../use-spade-roster.ts";
import type { ProfileComputerPlace } from "./profile-computer.tsx";
import { fullViewsOf, type FullView } from "./computer-fullscreen.tsx";
import { useBotPicture } from "./stream-picture.tsx";

/** The computer in a word: Live while something runs, Waking up… while it starts, else Offline. */
export function computerWord(
  state: ProfileComputerPlace["state"],
): "Live" | "Waking up…" | "Offline" {
  const computer = state.computer;
  if (computer?.state === "starting") return "Waking up…";
  if (computer?.state === "ready" || computer?.surfaces.some((each) => each.live)) return "Live";
  return "Offline";
}

const surfaceMeta: Record<FullView, { label: string; icon: typeof MonitorIcon }> = {
  screen: { label: "Screen", icon: MonitorIcon },
  browser: { label: "Browser", icon: GlobeSimpleIcon },
  terminal: { label: "Terminal", icon: TerminalWindowIcon },
};

/**
 * Activity's Computer card: "Bot's computer", its state, and a live thumbnail of its screen at
 * the right (opening full screen), followed inside the same rounded group by the bot's surfaces
 * (Screen, Browser, Terminal) that open in place inside the panel.
 */
export function ComputerCard(props: {
  bot: RosterBot;
  place: ProfileComputerPlace;
  /** Terminal, Screen or Browser, opened inside the panel. */
  onOpenSurface(kind: "terminal" | "screen" | "browser"): void;
}) {
  const { bot, place } = props;
  const word = computerWord(place.state);
  const { picture } = useBotPicture({ machine: bot.machine.key, bot: bot.id, surface: "screen" });
  const surfaces = fullViewsOf(place, bot);
  const isLive = (kind: FullView) =>
    place.state.computer?.surfaces.some((each) => each.kind === kind && each.live) === true;

  return (
    <ProfileCard>
      <button
        type="button"
        aria-label={`Open ${bot.name}'s computer`}
        {...part("list-row", undefined, "computer")}
        onClick={() => {
          // What it uses now, else the first surface it used, else its screen.
          const views = fullViewsOf(place, bot).filter((kind) => kind !== "terminal");
          const live = views.find((kind) =>
            place.state.computer?.surfaces.some((each) => each.kind === kind && each.live),
          );
          place.onView(place.view ?? live ?? views[0] ?? "screen");
        }}
        className={cn(profileRowClass, "min-h-18 py-3")}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-ui font-medium text-foreground">
            {`${bot.name}'s computer`}
          </span>
          <span className="flex items-center gap-2 truncate text-xs text-muted-foreground">
            {word === "Live" && (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-done" />
            )}
            <span className="truncate">{word}</span>
          </span>
        </span>
        <span
          className={cn(
            "grid h-12 w-20 shrink-0 place-items-center overflow-hidden rounded-md",
            picture && word !== "Offline"
              ? "bg-code"
              : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border-soft)]",
          )}
        >
          {picture && word !== "Offline" ? (
            <img alt="" src={picture.src} draggable={false} className="size-full object-cover" />
          ) : word === "Offline" ? (
            <Icon icon={EyeSlashIcon} size={18} className="text-muted-foreground" />
          ) : (
            <SpadeFace avatar={bot.avatar} size={28} state="acknowledge" />
          )}
        </span>
      </button>
      {surfaces.map((kind) => {
        const meta = surfaceMeta[kind];
        const live = isLive(kind);
        return (
          <button
            key={kind}
            type="button"
            {...part("list-row", undefined, `computer-${kind}`)}
            onClick={() => props.onOpenSurface(kind)}
            className={cn(profileRowClass, "min-h-11 py-2 text-ui font-medium text-foreground")}
          >
            <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
              <Icon icon={meta.icon} size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate">{meta.label}</span>
            {live && (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-done" />
            )}
            <Icon icon={CaretRightIcon} size={16} className="shrink-0 text-faint-foreground" />
          </button>
        );
      })}
    </ProfileCard>
  );
}
