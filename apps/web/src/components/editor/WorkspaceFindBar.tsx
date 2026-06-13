import type { WorkspaceFindMatchSummary, WorkspaceFindState } from "~/lib/editor/workspaceFind";
import { APP_FLOATING_TOOLBAR_CLASS_NAME, APP_SETTINGS_FIELD_CLASS_NAME } from "~/lib/appChrome";
import { cn } from "~/lib/utils";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaseSensitiveIcon,
  RegexIcon,
  ReplaceIcon,
  WholeWordIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface WorkspaceFindBarProps {
  readonly expandedReplace: boolean;
  readonly matchSummary: WorkspaceFindMatchSummary;
  readonly onClose: () => void;
  readonly onFindNext: () => void;
  readonly onFindPrevious: () => void;
  readonly onReplaceAll: () => void;
  readonly onReplaceNext: () => void;
  readonly onSelectAll: () => void;
  readonly onStateChange: (patch: Partial<WorkspaceFindState>) => void;
  readonly onToggleReplace: () => void;
  readonly open: boolean;
  readonly state: WorkspaceFindState;
}

function FindIconButton(props: {
  readonly active?: boolean;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/76 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
              props.active && "bg-primary/12 text-primary hover:bg-primary/16 hover:text-primary",
            )}
            disabled={props.disabled}
            onClick={props.onClick}
            aria-label={props.label}
            aria-pressed={props.active}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function WorkspaceFindBar(props: WorkspaceFindBarProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const hasSearch = props.state.search.length > 0;
  const matchLabel = hasSearch
    ? `${props.matchSummary.count}${props.matchSummary.capped ? "+" : ""}`
    : "0";

  useEffect(() => {
    if (!props.open) {
      return;
    }
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [props.open]);

  useEffect(() => {
    if (!props.open || !props.expandedReplace) {
      return;
    }
    window.requestAnimationFrame(() => {
      replaceInputRef.current?.focus();
    });
  }, [props.expandedReplace, props.open]);

  if (!props.open) {
    return null;
  }

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        props.onSelectAll();
        return;
      }
      if (event.shiftKey) {
        props.onFindPrevious();
        return;
      }
      props.onFindNext();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    }
  };

  const handleReplaceKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        props.onReplaceAll();
        return;
      }
      props.onReplaceNext();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    }
  };

  return (
    <div className="pointer-events-none absolute top-2 right-3 z-30 flex w-[min(42rem,calc(100%-1.5rem))] justify-end">
      <div
        className={cn(
          APP_FLOATING_TOOLBAR_CLASS_NAME,
          "pointer-events-auto grid max-w-full grid-cols-[minmax(12rem,1fr)_auto] gap-1.5 p-1.5",
        )}
      >
        <div className="grid min-w-0 grid-cols-1 gap-1">
          <div className="flex min-w-0 items-center gap-1">
            <input
              ref={searchInputRef}
              value={props.state.search}
              onChange={(event) => props.onStateChange({ search: event.target.value })}
              onKeyDown={handleSearchKeyDown}
              placeholder="Find in file"
              aria-label="Find in file"
              className={cn(
                APP_SETTINGS_FIELD_CLASS_NAME,
                "h-7 min-w-0 flex-1 rounded-md px-2 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground/55 focus:border-primary/45",
              )}
            />
            <span className="min-w-10 shrink-0 rounded-md bg-foreground/6 px-1.5 py-1 text-center font-mono text-[10px] tabular-nums text-muted-foreground">
              {matchLabel}
            </span>
          </div>
          {props.expandedReplace ? (
            <input
              ref={replaceInputRef}
              value={props.state.replace}
              onChange={(event) => props.onStateChange({ replace: event.target.value })}
              onKeyDown={handleReplaceKeyDown}
              placeholder="Replace"
              aria-label="Replace"
              className={cn(
                APP_SETTINGS_FIELD_CLASS_NAME,
                "h-7 min-w-0 rounded-md px-2 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground/55 focus:border-primary/45",
              )}
            />
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-start justify-end gap-0.5">
          <FindIconButton
            active={props.expandedReplace}
            label={props.expandedReplace ? "Hide replace" : "Show replace"}
            onClick={props.onToggleReplace}
          >
            <ReplaceIcon className="size-3.5" />
          </FindIconButton>
          <FindIconButton
            label="Previous match"
            onClick={props.onFindPrevious}
            disabled={!hasSearch}
          >
            <ArrowUpIcon className="size-3.5" />
          </FindIconButton>
          <FindIconButton label="Next match" onClick={props.onFindNext} disabled={!hasSearch}>
            <ArrowDownIcon className="size-3.5" />
          </FindIconButton>
          <FindIconButton
            active={props.state.caseSensitive}
            label="Match case"
            onClick={() => props.onStateChange({ caseSensitive: !props.state.caseSensitive })}
          >
            <CaseSensitiveIcon className="size-3.5" />
          </FindIconButton>
          <FindIconButton
            active={props.state.regexp}
            label="Use regular expression"
            onClick={() => props.onStateChange({ regexp: !props.state.regexp })}
          >
            <RegexIcon className="size-3.5" />
          </FindIconButton>
          <FindIconButton
            active={props.state.wholeWord}
            label="Whole word"
            onClick={() => props.onStateChange({ wholeWord: !props.state.wholeWord })}
          >
            <WholeWordIcon className="size-3.5" />
          </FindIconButton>
          {props.expandedReplace ? (
            <>
              <button
                type="button"
                className="h-7 rounded-md px-2 text-[11px] font-medium text-muted-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                disabled={!hasSearch}
                onClick={props.onReplaceNext}
              >
                Replace
              </button>
              <button
                type="button"
                className="h-7 rounded-md px-2 text-[11px] font-medium text-muted-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                disabled={!hasSearch}
                onClick={props.onReplaceAll}
              >
                All
              </button>
            </>
          ) : null}
          <FindIconButton label="Close find" onClick={props.onClose}>
            <XIcon className="size-3.5" />
          </FindIconButton>
        </div>
      </div>
    </div>
  );
}

export default WorkspaceFindBar;
