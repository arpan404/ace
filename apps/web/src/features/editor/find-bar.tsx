import { CaretDownIcon, CaretUpIcon, XIcon } from "@ace/icons";
import { useEffect, useRef } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import type { FindResults } from "./use-find.ts";

/** Find-in-file: a row above the text, so it never covers the first lines in a narrow panel. */
export function EditorFindBar(props: {
  query: string;
  count: number;
  index: number;
  status: FindResults["status"];
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  onQuery(query: string): void;
  onToggle(option: "regex" | "caseSensitive" | "wholeWord"): void;
  onStep(delta: 1 | -1): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const canStep = props.status === "ready" && props.count > 0;
  return (
    <search className="flex h-9 shrink-0 items-center gap-1 border-b bg-popover pr-1 pl-2.5">
      <input
        ref={input}
        aria-label="Find in file"
        placeholder="Find"
        value={props.query}
        spellCheck={false}
        onChange={(event) => props.onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (canStep) props.onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          }
        }}
        className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 text-ui text-foreground outline-none placeholder:text-subtle-foreground focus-visible:border-ring"
      />
      <Toggle
        label="Match case"
        pressed={props.caseSensitive}
        onClick={() => props.onToggle("caseSensitive")}
      >
        Aa
      </Toggle>
      <Toggle
        label="Use regular expression"
        pressed={props.regex}
        onClick={() => props.onToggle("regex")}
      >
        .*
      </Toggle>
      <Toggle
        label="Match whole word"
        pressed={props.wholeWord}
        onClick={() => props.onToggle("wholeWord")}
      >
        ab
      </Toggle>
      <span
        aria-live="polite"
        className="min-w-[64px] text-right text-xs text-subtle-foreground tabular-nums"
      >
        {props.query && props.status === "invalid" && "Invalid pattern"}
        {props.query && props.status === "pending" && "Searching..."}
        {props.query &&
          props.status === "ready" &&
          (props.count ? `${props.index + 1} of ${props.count}` : "No results")}
      </span>
      <IconButton
        icon={CaretUpIcon}
        label="Previous match"
        keys="shift+enter"
        size="sm"
        className="size-7"
        disabled={!canStep}
        onClick={() => props.onStep(-1)}
      />
      <IconButton
        icon={CaretDownIcon}
        label="Next match"
        keys="enter"
        size="sm"
        className="size-7"
        disabled={!canStep}
        onClick={() => props.onStep(1)}
      />
      <IconButton
        icon={XIcon}
        label="Close find"
        keys="escape"
        size="sm"
        className="size-7"
        onClick={props.onClose}
      />
    </search>
  );
}

function Toggle(props: { label: string; pressed: boolean; onClick(): void; children: string }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-sm font-mono text-xs focus-ring",
        props.pressed
          ? "bg-accent text-foreground"
          : "text-subtle-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}
