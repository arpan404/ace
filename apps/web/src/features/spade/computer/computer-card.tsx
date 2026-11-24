import { EyeSlashIcon } from "@ace/icons";
import { Icon } from "@/components/icon.tsx";
import { part } from "@/lib/suit-part.ts";
import { SpadeFace } from "../spade-face.tsx";
import type { RosterBot } from "../use-spade-roster.ts";
import type { ProfileComputerPlace } from "./profile-computer.tsx";
import { fullViewsOf } from "./computer-fullscreen.tsx";
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

/**
 * Activity's Computer card: "Bot's computer", its state, and a live thumbnail of its screen at
 * the right. It opens the full-screen view.
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
  const card = (
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
      className="flex min-h-[68px] w-full items-center gap-3 rounded-xl bg-surface-1 py-2 pr-2 pl-4 text-left focus-ring hover:bg-hover"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui font-medium text-foreground">{`${bot.name}'s computer`}</span>
        <span className="truncate text-ui text-muted-foreground">{word}</span>
      </span>
      <span className="grid h-13 w-22 shrink-0 place-items-center overflow-hidden rounded-lg bg-code">
        {picture && word !== "Offline" ? (
          <img alt="" src={picture.src} draggable={false} className="size-full object-cover" />
        ) : word === "Offline" ? (
          <Icon icon={EyeSlashIcon} size={18} className="text-muted-foreground" />
        ) : (
          <SpadeFace avatar={bot.avatar} size={28} state="acknowledge" />
        )}
      </span>
    </button>
  );
  return (
    <>
      {card}
      <div role="group" aria-label="Open in the panel" className="mt-1 flex gap-1 px-1">
        {surfaces.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => props.onOpenSurface(kind)}
            className="h-7 rounded-full px-2.5 text-ui text-muted-foreground focus-ring hover:bg-hover hover:text-foreground"
          >
            {kind === "terminal" ? "Terminal" : kind === "screen" ? "Screen" : "Browser"}
          </button>
        ))}
      </div>
    </>
  );
}
