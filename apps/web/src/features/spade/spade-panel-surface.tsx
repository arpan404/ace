import { ArrowsOutSimpleIcon, CaretLeftIcon } from "@ace/icons";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { BotTerminal } from "./computer/bot-terminal.tsx";
import { DriveLine } from "./computer/drive-line.tsx";
import { FileManager } from "./computer/file-manager.tsx";
import type { FilesAt, ProfileComputerPlace } from "./computer/profile-computer.tsx";
import { SurfacePicture } from "./computer/surface-picture.tsx";
import { roundButton } from "./spade-profile-parts.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/** What the panel shows in place of its tabs: a file or the files, or one surface of its computer. */
export type PanelSurface =
  | { kind: "files"; at: FilesAt }
  | { kind: "terminal" | "screen" | "browser" };

const names = { terminal: "Terminal", screen: "Screen", browser: "Browser" } as const;

/** "Files", or the open file's own name. */
export const panelSurfaceTitle = (surface: PanelSurface) =>
  surface.kind === "files" ? (surface.at.file?.split("/").at(-1) ?? "Files") : names[surface.kind];

/**
 * A file, the terminal, or the screen or browser, inside the side panel: a slim header (back
 * arrow, its name, and an expand button to the same surface full screen) over the live view at
 * the panel's width. One surface at a time; back, or Escape, returns to the tab.
 */
export function PanelSurfaceView(props: {
  bot: RosterBot;
  surface: PanelSurface;
  place: ProfileComputerPlace;
  onBack(): void;
  /** Opens the same surface in the full-screen computer. */
  onExpand(): void;
}) {
  const { bot, surface, place } = props;
  const { state } = place;
  const title = panelSurfaceTitle(surface);
  return (
    <section aria-label={title} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 px-4">
        <IconButton
          icon={CaretLeftIcon}
          label="Back"
          tip="Back"
          size="default"
          className={roundButton}
          onClick={props.onBack}
        />
        <h3 className="min-w-0 flex-1 truncate text-md font-semibold text-foreground">{title}</h3>
        <IconButton
          icon={ArrowsOutSimpleIcon}
          label="Full screen"
          tip="Full screen"
          size="default"
          className={roundButton}
          onClick={props.onExpand}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
        {surface.kind === "files" ? (
          <FileManager
            key={`${bot.machine.key}/${bot.id}`}
            bot={bot}
            folder={
              surface.at.file
                ? surface.at.file.split("/").slice(0, -1).join("/")
                : surface.at.folder
            }
            file={surface.at.file}
            side={place.side}
            writable={state.mayAct}
          />
        ) : surface.kind === "terminal" ? (
          <div className="flex flex-col gap-3">
            <div role="tabpanel" aria-label="Terminal" className="-mx-4 -my-4 h-96">
              <BotTerminal bot={bot} mayType={state.mayAct} />
            </div>
            <DriveLine bot={bot} state={state} what="terminal" />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              role="tabpanel"
              aria-label={names[surface.kind]}
              className="overflow-hidden rounded-lg bg-surface-1"
            >
              <SurfacePicture
                machine={bot.machine}
                bot={bot}
                kind={surface.kind}
                surface={state.computer?.surfaces.find((each) => each.kind === surface.kind)}
                threadId={state.computer?.threadId}
                mayAct={state.mayAct}
                driving={state.driving}
                label={`${bot.name}'s ${surface.kind}`}
              />
            </div>
            <DriveLine bot={bot} state={state} what={surface.kind} />
          </div>
        )}
      </div>
    </section>
  );
}
