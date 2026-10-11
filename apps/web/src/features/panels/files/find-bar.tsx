import { ArrowClockwiseIcon, CaretDownIcon, CaretUpIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import type { FindStatus } from "./use-find-hits.ts";

/** Find in file distinguishes an unfinished or failed search from an empty result. */
export function FindBar(props: {
  query: string;
  count: number;
  index: number;
  status: FindStatus;
  onRetry(): void;
  onQuery(query: string): void;
  onStep(delta: 1 | -1): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const canStep = props.status === "ready" && props.count > 0;
  return (
    <search className="absolute top-2 right-3 z-10 flex h-9 items-center gap-1 rounded-lg border bg-popover pr-1 pl-2.5 shadow-[var(--glass-shadow)]">
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
        className="h-full w-40 bg-transparent text-ui text-foreground focus-ring placeholder:text-subtle-foreground"
      />
      <span
        aria-live="polite"
        className="min-w-[64px] text-right text-xs text-subtle-foreground tabular-nums"
      >
        {props.query && props.status === "pending" && "Searching..."}
        {props.query && props.status === "failed" && "Search unavailable"}
        {props.query &&
          props.status === "ready" &&
          (props.count ? `${props.index + 1} of ${props.count}` : "No results")}
      </span>
      {props.status === "failed" && (
        <IconButton
          icon={ArrowClockwiseIcon}
          label="Retry search"
          size="sm"
          className="size-7"
          onClick={props.onRetry}
        />
      )}
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
