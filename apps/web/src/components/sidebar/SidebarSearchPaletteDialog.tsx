import { type ProjectId } from "@ace/contracts";
import { IconSearch } from "@tabler/icons-react";
import {
  ChevronLeftIcon,
  FolderIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
} from "lucide-react";
import { memo, type KeyboardEvent, type RefObject } from "react";

import {
  APP_INTERACTIVE_HOVER_CLASS_NAME,
  APP_SETTINGS_FIELD_CLASS_NAME,
} from "../../lib/appChrome";
import type { Project } from "../../types";
import { GLASS_FOOTER_CLASS_NAME } from "../ui/glass";
import { Kbd } from "../ui/kbd";
import { ProjectAvatar } from "../ProjectAvatar";
import { CommandDialog, CommandDialogPopup } from "../ui/command";
import type { SearchPaletteItem, SearchPaletteMode } from "./sidebarTypes";

const SearchPaletteFooterHints = memo(function SearchPaletteFooterHints() {
  return (
    <div
      className={`flex items-center justify-between gap-4 px-4 py-2.5 text-xs text-muted-foreground ${GLASS_FOOTER_CLASS_NAME}`}
    >
      <div className="flex flex-wrap items-center gap-4">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex gap-0.5">
            <Kbd className="h-4.5 min-w-0 px-1.5 text-[10px]">↑</Kbd>
            <Kbd className="h-4.5 min-w-0 px-1.5 text-[10px]">↓</Kbd>
          </span>
          <span className="font-medium">Navigate</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd className="h-4.5 min-w-0 px-2 text-[10px]">Enter</Kbd>
          <span className="font-medium">Select</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd className="h-4.5 min-w-0 px-1.5 text-[10px]">Esc</Kbd>
          <span className="font-medium">Close</span>
        </span>
      </div>
    </div>
  );
});

const SearchPaletteActionIcon = memo(function SearchPaletteActionIcon(props: {
  readonly type: SearchPaletteItem["type"];
}) {
  if (props.type === "action.new-thread") {
    return <SquarePenIcon className="size-4 shrink-0" strokeWidth={2} />;
  }
  if (props.type === "action.new-project") {
    return <FolderIcon className="size-4 shrink-0" strokeWidth={2} />;
  }
  if (props.type === "action.open-terminals") {
    return <TerminalIcon className="size-4 shrink-0" strokeWidth={2} />;
  }
  return <SettingsIcon className="size-4 shrink-0" strokeWidth={2} />;
});

export const SidebarSearchPaletteDialog = memo(function SidebarSearchPaletteDialog(props: {
  readonly open: boolean;
  readonly mode: SearchPaletteMode;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly activeIndex: number;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly items: ReadonlyArray<SearchPaletteItem>;
  readonly actionItems: ReadonlyArray<SearchPaletteItem>;
  readonly projectItems: ReadonlyArray<SearchPaletteItem>;
  readonly threadItems: ReadonlyArray<SearchPaletteItem>;
  readonly indexById: ReadonlyMap<string, number>;
  readonly projectById: ReadonlyMap<ProjectId, Project>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onBack: () => void;
  readonly onQueryChange: (value: string) => void;
  readonly onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onHoverItem: (itemId: string) => void;
  readonly onSelectItem: (item: SearchPaletteItem) => void;
}) {
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className="glass-surface flex max-h-[min(31.5rem,calc(100dvh-2rem))] w-[min(44rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border p-0">
        <div className="flex items-center gap-3 border-b border-border/40 px-4 py-3">
          {props.mode === "new-thread-project" ? (
            <button
              type="button"
              className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-all active:scale-95 ${APP_INTERACTIVE_HOVER_CLASS_NAME}`}
              onClick={props.onBack}
              aria-label="Back to search"
            >
              <ChevronLeftIcon className="size-5" strokeWidth={2.5} />
            </button>
          ) : (
            <IconSearch className="size-5 shrink-0 text-muted-foreground/60" strokeWidth={2} />
          )}
          <input
            ref={props.inputRef}
            className={`h-9 min-w-0 flex-1 rounded-lg px-3 text-sm font-medium text-foreground transition-all placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/30 ${APP_SETTINGS_FIELD_CLASS_NAME}`}
            placeholder={
              props.mode === "new-thread-project"
                ? "Select project for a new thread..."
                : "Search commands, projects, and threads..."
            }
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            onKeyDown={props.onInputKeyDown}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" ref={props.listRef}>
          {props.items.length === 0 ? (
            <p className="px-0 py-6 text-center text-sm text-muted-foreground/60">
              No matching results
            </p>
          ) : (
            <div className="py-1">
              {props.mode === "root" &&
              props.normalizedQuery.length === 0 &&
              props.actionItems.length > 0 ? (
                <p className="px-0 pt-0 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
                  Actions
                </p>
              ) : null}
              {props.actionItems.map((item) => {
                const itemIndex = props.indexById.get(item.id) ?? -1;
                const isActive = itemIndex === props.activeIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-search-palette-index={itemIndex}
                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition-all duration-150 ${
                      isActive
                        ? "bg-foreground/[0.06] text-foreground"
                        : "text-foreground/80 hover:bg-foreground/[0.04] hover:text-foreground"
                    }`}
                    onMouseMove={() => props.onHoverItem(item.id)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => props.onSelectItem(item)}
                  >
                    <span className={`text-muted-foreground ${isActive ? "text-primary/70" : ""}`}>
                      <SearchPaletteActionIcon type={item.type} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </button>
                );
              })}

              {props.projectItems.length > 0 ? (
                <>
                  <p className="px-0 pt-3 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
                    {props.mode === "new-thread-project"
                      ? "Projects"
                      : props.normalizedQuery.length === 0
                        ? "Recent Projects"
                        : "Projects"}
                  </p>
                  {props.projectItems.map((item) => {
                    if (item.type !== "project") {
                      return null;
                    }
                    const itemIndex = props.indexById.get(item.id) ?? -1;
                    const isActive = itemIndex === props.activeIndex;
                    const project =
                      item.connectionUrl === undefined
                        ? props.projectById.get(item.projectId)
                        : undefined;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-search-palette-index={itemIndex}
                        className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-all duration-150 ${
                          isActive
                            ? "bg-foreground/[0.06] text-foreground"
                            : "text-foreground/80 hover:bg-foreground/[0.04] hover:text-foreground"
                        }`}
                        onMouseMove={() => props.onHoverItem(item.id)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => props.onSelectItem(item)}
                      >
                        {project ? (
                          <ProjectAvatar project={project} className="size-5" />
                        ) : (
                          <FolderIcon
                            className="size-4 shrink-0 text-muted-foreground/60"
                            strokeWidth={2}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{item.label}</span>
                          <span className="block truncate text-xs font-normal text-muted-foreground">
                            {item.description}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </>
              ) : null}

              {props.mode === "root" && props.threadItems.length > 0 ? (
                <>
                  <p className="px-0 pt-3 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
                    {props.normalizedQuery.length === 0 ? "Recent Threads" : "Threads"}
                  </p>
                  {props.threadItems.map((item) => {
                    const itemIndex = props.indexById.get(item.id) ?? -1;
                    const isActive = itemIndex === props.activeIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-search-palette-index={itemIndex}
                        className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-all duration-150 ${
                          isActive
                            ? "bg-foreground/[0.06] text-foreground"
                            : "text-foreground/80 hover:bg-foreground/[0.04] hover:text-foreground"
                        }`}
                        onMouseMove={() => props.onHoverItem(item.id)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => props.onSelectItem(item)}
                      >
                        <SquarePenIcon
                          className="size-4 shrink-0 text-muted-foreground/60"
                          strokeWidth={2}
                        />
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{item.label}</span>
                          <span className="block truncate text-xs font-normal text-muted-foreground">
                            {item.description}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </>
              ) : null}
            </div>
          )}
        </div>

        <SearchPaletteFooterHints />
      </CommandDialogPopup>
    </CommandDialog>
  );
});
