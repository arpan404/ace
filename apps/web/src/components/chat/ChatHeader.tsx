import { IconPinFilled, IconPinnedOff } from "@tabler/icons-react";
import {
  Archive,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Folder,
  GitFork,
  Link,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
} from "lucide-react";
import { type ReactNode } from "react";
import { Button } from "../ui/button";
import { PremiumEnvironmentIcon, PremiumPanelIcon } from "../Icons";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME } from "~/lib/desktopChrome";
import { cn } from "~/lib/utils";

const CHAT_HEADER_PANEL_BUTTON_CLASS_NAME = cn(
  DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
  "size-8.5 rounded-xl text-foreground/42 transition-[background-color,border-color,box-shadow,color,transform] duration-150 ease-out hover:!bg-foreground/[0.055] hover:text-foreground/74 active:scale-[0.98] active:!bg-foreground/[0.075] [&_svg]:size-[19px] [&_svg]:drop-shadow-[0_1px_0_rgba(255,255,255,0.08)]",
);

const CHAT_HEADER_PANEL_BUTTON_ACTIVE_CLASS_NAME =
  "!border-white/[0.075] !bg-foreground/[0.095] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_8px_18px_rgba(0,0,0,0.16)] hover:!bg-foreground/[0.12] hover:text-foreground";

const CHAT_HEADER_PANEL_ICON_CLASS_NAME = "size-5";

const CHAT_HEADER_MENU_TRIGGER_CLASS_NAME = CHAT_HEADER_PANEL_BUTTON_CLASS_NAME;

const CHAT_HEADER_MENU_POPUP_CLASS_NAME =
  "w-[min(calc(100vw-1rem),17.25rem)] overflow-hidden rounded-[1.15rem] border-border/50 bg-[color:color-mix(in_oklch,var(--popover)_97%,var(--background)_3%)] shadow-[0_24px_70px_-46px_rgb(0_0_0/.58)] supports-[backdrop-filter]:backdrop-blur-2xl supports-[backdrop-filter]:backdrop-saturate-[1.14] dark:border-border/40 dark:bg-[color:color-mix(in_oklch,var(--popover)_94%,var(--background)_6%)] dark:shadow-[0_24px_70px_-44px_rgb(0_0_0/.86)]";

const CHAT_HEADER_MENU_ITEM_CLASS_NAME =
  "min-h-8 rounded-[0.7rem] px-2.5 py-1 text-[13px] font-normal text-foreground/84 transition-colors duration-150 data-highlighted:bg-foreground/[0.045] data-highlighted:text-foreground dark:data-highlighted:bg-white/[0.065] [&>svg:not([class*='opacity-'])]:opacity-68";

const CHAT_HEADER_MENU_SEPARATOR_CLASS_NAME = "mx-2 my-1.5 bg-border/35";

interface ChatHeaderProps {
  activeThreadTitle: string;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  environmentPanelOpen: boolean;
  rightSidePanelToggleShortcutLabel: string | null;
  rightSidePanelOpen: boolean;
  menuActions?: ChatHeaderMenuActions | null;
  onToggleEnvironmentPanel: () => void;
  onToggleTerminal: () => void;
  onToggleRightSidePanel: () => void;
  onUnpinThread?: (() => void) | null;
  pinnedThread?: boolean;
  reliabilitySlot?: ReactNode;
  showThreadIdentity?: boolean;
}

interface ChatHeaderMenuActions {
  canArchive: boolean;
  canCopyWorkspacePath: boolean;
  canFork: boolean;
  canOpenSideChat: boolean;
  canOpenWindow: boolean;
  onArchive: () => void;
  onCopyLink: () => void;
  onCopyThreadId: () => void;
  onCopyTitle: () => void;
  onCopyWorkspacePath: () => void;
  onFork: () => void;
  onOpenSideChat: () => void;
  onOpenWindow: () => void;
  onRename: () => void;
  onTogglePinned: () => void;
  pinned: boolean;
}

export function ChatHeader({
  activeThreadTitle,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  environmentPanelOpen,
  rightSidePanelToggleShortcutLabel,
  rightSidePanelOpen,
  menuActions,
  onToggleEnvironmentPanel,
  onToggleTerminal,
  onToggleRightSidePanel,
  onUnpinThread,
  pinnedThread = false,
  reliabilitySlot,
  showThreadIdentity = true,
}: ChatHeaderProps) {
  const bottomPanelTooltipLabel = !terminalAvailable
    ? "Bottom panel is unavailable until this thread has an active project."
    : terminalToggleShortcutLabel
      ? `Toggle bottom panel (${terminalToggleShortcutLabel})`
      : "Toggle bottom panel";
  const rightSidePanelTooltipLabel = `${rightSidePanelOpen ? "Close" : "Open"} panel${
    rightSidePanelToggleShortcutLabel ? ` (${rightSidePanelToggleShortcutLabel})` : ""
  }`;
  const rightSidePanelButtonLabel = rightSidePanelToggleShortcutLabel
    ? `Toggle panel (${rightSidePanelToggleShortcutLabel})`
    : "Toggle panel";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:gap-2">
        {showThreadIdentity ? (
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            {pinnedThread ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="group/thread-header-pin -ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-lg text-foreground/58 transition-[background-color,color,opacity,transform] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/86 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                      aria-label={`Unpin ${activeThreadTitle}`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onUnpinThread?.();
                      }}
                    >
                      <span className="relative inline-flex size-4 items-center justify-center">
                        <IconPinFilled className="absolute size-4 opacity-100 transition-opacity duration-150 group-hover/thread-header-pin:opacity-0 group-focus-visible/thread-header-pin:opacity-0" />
                        <IconPinnedOff className="absolute size-4 opacity-0 transition-opacity duration-150 group-hover/thread-header-pin:opacity-100 group-focus-visible/thread-header-pin:opacity-100" />
                      </span>
                    </button>
                  }
                />
                <TooltipPopup side="bottom">Unpin thread</TooltipPopup>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <h2 className="m-0 flex min-w-0 shrink items-center truncate text-[13px] leading-[18px] font-medium tracking-tight text-foreground/80">
                    {activeThreadTitle}
                  </h2>
                }
              />
              <TooltipPopup side="bottom" className="max-w-96 whitespace-pre-wrap">
                {activeThreadTitle}
              </TooltipPopup>
            </Tooltip>
            {menuActions ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      className={CHAT_HEADER_MENU_TRIGGER_CLASS_NAME}
                      aria-label="Thread actions"
                    />
                  }
                >
                  <MoreHorizontal className={CHAT_HEADER_PANEL_ICON_CLASS_NAME} />
                </MenuTrigger>
                <MenuPopup
                  align="start"
                  side="bottom"
                  className={CHAT_HEADER_MENU_POPUP_CLASS_NAME}
                  listClassName="p-1.5"
                >
                  <MenuItem
                    className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}
                    onClick={menuActions.onTogglePinned}
                  >
                    {menuActions.pinned ? <PinOff /> : <Pin />}
                    {menuActions.pinned ? "Unpin chat" : "Pin chat"}
                  </MenuItem>
                  <MenuItem
                    className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}
                    onClick={menuActions.onRename}
                  >
                    <Pencil />
                    Rename chat
                  </MenuItem>
                  <MenuItem
                    className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}
                    disabled={!menuActions.canArchive}
                    onClick={menuActions.onArchive}
                  >
                    <Archive />
                    Archive chat
                  </MenuItem>
                  <MenuSeparator className={CHAT_HEADER_MENU_SEPARATOR_CLASS_NAME} />
                  <MenuItem
                    className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}
                    disabled={!menuActions.canOpenSideChat}
                    onClick={menuActions.onOpenSideChat}
                  >
                    <MessageSquarePlus />
                    Open side chat
                  </MenuItem>
                  <MenuSub>
                    <MenuSubTrigger className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}>
                      <Copy />
                      Copy
                    </MenuSubTrigger>
                    <MenuSubPopup
                      className={CHAT_HEADER_MENU_POPUP_CLASS_NAME}
                      listClassName="p-1.5"
                    >
                      <MenuItem
                        className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}
                        onClick={menuActions.onCopyTitle}
                      >
                        <FileText />
                        Title
                      </MenuItem>
                      <MenuItem
                        className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}
                        onClick={menuActions.onCopyLink}
                      >
                        <Link />
                        Link
                      </MenuItem>
                      <MenuItem
                        className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}
                        onClick={menuActions.onCopyThreadId}
                      >
                        <Copy />
                        Thread ID
                      </MenuItem>
                      <MenuItem
                        className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}
                        disabled={!menuActions.canCopyWorkspacePath}
                        onClick={menuActions.onCopyWorkspacePath}
                      >
                        <Folder />
                        Workspace path
                      </MenuItem>
                    </MenuSubPopup>
                  </MenuSub>
                  <MenuSub>
                    <MenuSubTrigger
                      className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}
                      disabled={!menuActions.canFork}
                    >
                      <GitFork />
                      Fork
                    </MenuSubTrigger>
                    <MenuSubPopup
                      className={CHAT_HEADER_MENU_POPUP_CLASS_NAME}
                      listClassName="p-1.5"
                    >
                      <MenuItem
                        className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}
                        disabled={!menuActions.canFork}
                        onClick={menuActions.onFork}
                      >
                        <GitFork />
                        Fork chat
                      </MenuItem>
                    </MenuSubPopup>
                  </MenuSub>
                  <MenuItem className={CHAT_HEADER_MENU_ITEM_CLASS_NAME} disabled>
                    <Clock />
                    Add automation...
                  </MenuItem>
                  <MenuSeparator className={CHAT_HEADER_MENU_SEPARATOR_CLASS_NAME} />
                  <MenuItem
                    className={CHAT_HEADER_MENU_ITEM_CLASS_NAME}
                    disabled={!menuActions.canOpenWindow}
                    onClick={menuActions.onOpenWindow}
                  >
                    <ExternalLink />
                    Open in new window
                  </MenuItem>
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex shrink-0 items-center gap-0.5">
          {reliabilitySlot}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  className={cn(
                    CHAT_HEADER_PANEL_BUTTON_CLASS_NAME,
                    environmentPanelOpen && CHAT_HEADER_PANEL_BUTTON_ACTIVE_CLASS_NAME,
                  )}
                  onClick={onToggleEnvironmentPanel}
                  aria-pressed={environmentPanelOpen}
                  aria-label="Toggle environment panel"
                />
              }
            >
              <PremiumEnvironmentIcon className={CHAT_HEADER_PANEL_ICON_CLASS_NAME} />
            </TooltipTrigger>
            <TooltipPopup side="bottom" align="end">
              Environment
            </TooltipPopup>
          </Tooltip>
          {!rightSidePanelOpen ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      className={cn(
                        CHAT_HEADER_PANEL_BUTTON_CLASS_NAME,
                        terminalOpen && CHAT_HEADER_PANEL_BUTTON_ACTIVE_CLASS_NAME,
                      )}
                      onClick={onToggleTerminal}
                      disabled={!terminalAvailable}
                      aria-pressed={terminalOpen}
                      aria-label={
                        terminalToggleShortcutLabel
                          ? `Toggle bottom panel (${terminalToggleShortcutLabel})`
                          : "Toggle bottom panel"
                      }
                    />
                  }
                >
                  <PremiumPanelIcon
                    className={CHAT_HEADER_PANEL_ICON_CLASS_NAME}
                    open={terminalOpen}
                    side="bottom"
                  />
                </TooltipTrigger>
                <TooltipPopup side="bottom" align="end">
                  {bottomPanelTooltipLabel}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      className={CHAT_HEADER_PANEL_BUTTON_CLASS_NAME}
                      onClick={onToggleRightSidePanel}
                      aria-pressed={false}
                      aria-label={rightSidePanelButtonLabel}
                    />
                  }
                >
                  <PremiumPanelIcon
                    className={CHAT_HEADER_PANEL_ICON_CLASS_NAME}
                    open={false}
                    side="right"
                  />
                </TooltipTrigger>
                <TooltipPopup side="bottom" align="end">
                  {rightSidePanelTooltipLabel}
                </TooltipPopup>
              </Tooltip>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
