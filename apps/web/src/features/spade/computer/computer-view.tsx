import type { SpadeChatItem, SpadeHelperStep, SpadeSurfaceKind } from "@ace/ui-core/spade-chat";
import {
  FolderIcon,
  GlobeIcon,
  MonitorIcon,
  TerminalWindowIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useRef } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import type { ConversationFollow } from "../conversation-follow.ts";
import { SpadeActivity } from "../spade-activity.tsx";
import { SpadeHelperLine } from "../spade-helper-line.tsx";
import type { RosterBot } from "../use-spade-roster.ts";
import { BotTerminal } from "./bot-terminal.tsx";
import { DriverStatus } from "./driver-status.tsx";
import { FileManager } from "./file-manager.tsx";
import { panelSectionNames, panelSections, type PanelSection } from "./panel-place.ts";
import { SurfacePicture } from "./surface-picture.tsx";
import type { BotComputerState } from "./use-bot-computer.ts";

/** The surfaces' marks, for the bot's page's list of what it used. */
export const surfaceIcons: Record<SpadeSurfaceKind, PhosphorIcon> = {
  browser: GlobeIcon,
  screen: MonitorIcon,
  terminal: TerminalWindowIcon,
  files: FolderIcon,
};

/** Where the file manager is: a folder, and a file in it open. */
export interface FilesAt {
  folder: string;
  file?: string | undefined;
}

type Helper = Extract<SpadeChatItem, { kind: "helper" }>;

const computerSection = (section: PanelSection): section is SpadeSurfaceKind =>
  section !== "activity" && section !== "helpers";

/**
 * The right panel beside a bot's conversation: its sections as words (Browser, Screen,
 * Terminal, Files, Activity, Helpers; the ones the bot uses now say "in use" to a screen reader
 * only), then Close, or Chat where the panel covers the chat. On the computer's sections, who has
 * it in one sentence with Take over or Hand back (cowork, ADR 0143) heads the surface, which
 * takes the person's input in cowork without taking over.
 */
export function ComputerPanel(props: {
  bot: RosterBot;
  state: BotComputerState;
  section: PanelSection;
  onSection(section: PanelSection): void;
  files: FilesAt;
  onFiles(to: FilesAt): void;
  side: Pick<ConversationFollow, "onSide" | "onEnded"> | undefined;
  helpers: readonly Helper[];
  onHelperSteps?: ((job: string) => Promise<readonly SpadeHelperStep[]>) | undefined;
  /** It covers the chat: its way back reads Chat. */
  covering: boolean;
  onClose(): void;
}) {
  const { state, bot, section } = props;
  const tabs = useRef<HTMLDivElement>(null);
  const surface = computerSection(section)
    ? state.computer?.surfaces.find((each) => each.kind === section)
    : undefined;
  const live = (kind: PanelSection) =>
    state.computer?.surfaces.some((each) => each.kind === kind && each.live) === true;
  // Arrow keys move between sections, as a tab list does.
  const move = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const at = panelSections.indexOf(section);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = panelSections[(at + step + panelSections.length) % panelSections.length];
    if (!next) return;
    event.preventDefault();
    props.onSection(next);
    tabs.current?.querySelector<HTMLElement>(`[data-section="${next}"]`)?.focus();
  };
  return (
    <section aria-label={`${bot.name}'s computer`} className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <div
          ref={tabs}
          role="tablist"
          aria-label="Panel"
          onKeyDown={move}
          className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {panelSections.map((kind) => {
            const selected = kind === section;
            return (
              <button
                key={kind}
                type="button"
                role="tab"
                data-section={kind}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => props.onSection(kind)}
                className={cn(
                  "h-7 shrink-0 rounded-sm px-2 text-ui transition-colors duration-(--motion-fast) focus-ring",
                  selected
                    ? "bg-active text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {panelSectionNames[kind]}
                {live(kind) && kind !== "files" && <span className="sr-only">, in use</span>}
              </button>
            );
          })}
        </div>
        <Button size="sm" variant="ghost" onClick={props.onClose} className="shrink-0">
          {props.covering ? "Chat" : "Close"}
        </Button>
      </div>
      {computerSection(section) && (
        <div className="@container flex h-12 shrink-0 items-center gap-2 px-3">
          <DriverStatus bot={bot} state={state} fill />
        </div>
      )}
      <div
        role="tabpanel"
        aria-label={panelSectionNames[section]}
        className="min-h-0 flex-1 overflow-auto"
      >
        {section === "browser" || section === "screen" ? (
          <SurfacePicture
            machine={bot.machine}
            bot={bot}
            kind={section}
            surface={surface}
            threadId={state.computer?.threadId}
            mayAct={state.mayAct}
            driving={state.driving}
            label={`${bot.name}'s ${section === "browser" ? "browser" : "screen"}`}
          />
        ) : section === "terminal" ? (
          <>
            {surface?.endingStuck && (
              <p role="status" className="px-5 pt-1 text-ui text-muted-foreground">
                Still ending the last command
              </p>
            )}
            <BotTerminal bot={bot} mayType={state.mayAct} />
          </>
        ) : section === "files" ? (
          <FileManager
            bot={bot}
            folder={props.files.folder}
            file={props.files.file}
            onOpen={props.onFiles}
            side={props.side}
            writable={state.mayAct}
          />
        ) : section === "activity" ? (
          <div className="pb-6 [--column:100%]">
            <SpadeActivity bot={bot} />
          </div>
        ) : (
          <Helpers helpers={props.helpers} onHelperSteps={props.onHelperSteps} />
        )}
      </div>
    </section>
  );
}

/** The helpers this conversation started, newest last, each opening to its own steps. */
function Helpers(props: {
  helpers: readonly Helper[];
  onHelperSteps?: ((job: string) => Promise<readonly SpadeHelperStep[]>) | undefined;
}) {
  const read = props.onHelperSteps;
  if (!props.helpers.length)
    return (
      <p className="px-4 pt-4 text-ui text-muted-foreground">No helpers in this conversation.</p>
    );
  return (
    <ul aria-label="Helpers" className="flex flex-col gap-2 px-1.5 pt-3 pb-6 [&_[role=note]]:pl-2">
      {props.helpers.map((helper) => (
        <li key={helper.key}>
          <SpadeHelperLine
            text={helper.text}
            open={helper.open}
            readSteps={read ? () => read(helper.job) : undefined}
          />
        </li>
      ))}
    </ul>
  );
}
