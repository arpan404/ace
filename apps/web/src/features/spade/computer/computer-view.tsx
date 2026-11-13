import {
  spadeComputerTabs,
  spadeSurfaceNames,
  type SpadeAvatar,
  type SpadeSurfaceKind,
} from "@ace/ui-core/spade-chat";
import {
  ArrowsInSimpleIcon,
  CaretLeftIcon,
  FolderIcon,
  GlobeIcon,
  MonitorIcon,
  TerminalWindowIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import type { ConversationFollow } from "../conversation-follow.ts";
import { SpadeFace } from "../spade-face.tsx";
import { BotTerminal } from "./bot-terminal.tsx";
import { FileManager } from "./file-manager.tsx";
import { SurfacePicture } from "./surface-picture.tsx";
import type { BotComputerState } from "./use-bot-computer.ts";

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

/**
 * The bot's computer in the main column: a switcher of what it uses now (Files always), who
 * drives with Take over or Hand back, and the surface itself. On a phone it is the whole screen,
 * with ‹ Chat at the top and who drives at the bottom.
 */
export function ComputerView(props: {
  bot: { id: string; name: string; avatar: SpadeAvatar };
  machine: { key: string; name: string };
  state: BotComputerState;
  open: SpadeSurfaceKind;
  onOpen(kind: SpadeSurfaceKind): void;
  files: FilesAt;
  onFiles(to: FilesAt): void;
  side: Pick<ConversationFollow, "onSide"> | undefined;
  phone: boolean;
  onCollapse(): void;
}) {
  const { state, bot } = props;
  const tabs = spadeComputerTabs(state.computer, props.open);
  const surface = state.computer?.surfaces.find((each) => each.kind === props.open);
  const status = <DriverStatus bot={bot} state={state} phone={props.phone} />;
  return (
    <section aria-label={`${bot.name}'s computer`} className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        {props.phone && (
          <Button size="sm" variant="ghost" onClick={props.onCollapse} className="-ml-1 gap-0.5">
            <Icon icon={CaretLeftIcon} size={14} />
            Chat
          </Button>
        )}
        <div
          role="tablist"
          aria-label="Computer"
          className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-secondary p-0.5"
        >
          {tabs.map((kind) => {
            const live = state.computer?.surfaces.some((each) => each.kind === kind && each.live);
            const selected = kind === props.open;
            return (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => props.onOpen(kind)}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-ui transition-colors duration-(--motion-fast) focus-ring",
                  selected
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon icon={surfaceIcons[kind]} size={14} />
                {spadeSurfaceNames[kind]}
                {live && kind !== "files" && (
                  <span
                    aria-label="live"
                    className="size-1.5 rounded-full bg-status-working"
                    role="img"
                  />
                )}
              </button>
            );
          })}
        </div>
        {!props.phone && (
          <>
            <span className="min-w-0 flex-1" />
            {status}
            <IconButton
              icon={ArrowsInSimpleIcon}
              label="Back to the chat"
              tip="Collapse"
              onClick={props.onCollapse}
            />
          </>
        )}
      </div>
      <div role="tabpanel" aria-label={spadeSurfaceNames[props.open]} className="min-h-0 flex-1">
        {props.open === "browser" || props.open === "screen" ? (
          <SurfacePicture
            surfaceKey={{ machine: props.machine.key, bot: bot.id, surface: props.open }}
            surface={surface}
            driving={state.driving}
            label={`${bot.name}'s ${props.open === "browser" ? "browser" : "screen"}`}
          />
        ) : props.open === "terminal" ? (
          <BotTerminal bot={bot} driving={state.driving} />
        ) : (
          <FileManager
            bot={bot}
            folder={props.files.folder}
            file={props.files.file}
            onOpen={props.onFiles}
            side={props.side}
          />
        )}
      </div>
      {props.phone && (
        <div className="flex h-14 shrink-0 items-center gap-2 border-t border-border px-3">
          {status}
        </div>
      )}
    </section>
  );
}

/** "Spade is driving · Take over", or "You're driving. Spade is paused. · Hand back". */
function DriverStatus(props: {
  bot: { name: string; avatar: SpadeAvatar };
  state: BotComputerState;
  phone: boolean;
}) {
  const { state, bot } = props;
  return (
    <div role="status" className={cn("flex min-w-0 items-center gap-2", props.phone && "flex-1")}>
      {state.driving ? (
        <p className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
          <span className="text-foreground">You're driving.</span> {`${bot.name} is paused.`}
        </p>
      ) : (
        <p className="flex min-w-0 flex-1 items-center gap-2 truncate text-ui text-muted-foreground">
          <SpadeFace avatar={bot.avatar} size={20} state="working" />
          <span className="truncate">{`${bot.name} is driving`}</span>
        </p>
      )}
      <Button
        size="sm"
        variant={state.driving ? "primary" : "secondary"}
        disabled={state.pending !== undefined}
        onClick={state.driving ? state.handBack : state.takeOver}
        className="shrink-0"
      >
        {state.driving ? "Hand back" : "Take over"}
      </Button>
    </div>
  );
}
