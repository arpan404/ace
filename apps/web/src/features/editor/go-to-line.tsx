import type { Position } from "@ace/editor";
import { useEffect, useRef, useState } from "react";

/*
 * Go to line (Ctrl+G): a row above the text that takes "line" or "line:column", both 1-based as
 * the gutter shows them, and moves the caret there.
 */

/** The position "line[:column]" names, clamped to the document; undefined when it names none. */
export function parseGoTo(
  input: string,
  lineCount: number,
  lineLength: (line: number) => number,
): Position | undefined {
  const match = /^\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(input);
  if (!match) return undefined;
  const line = Math.min(Math.max(1, Number(match[1])), Math.max(1, lineCount)) - 1;
  const column = match[2] ? Math.min(Math.max(1, Number(match[2])), lineLength(line) + 1) - 1 : 0;
  return { line, column };
}

export function GoToLineBar(props: {
  lineCount: number;
  lineLength(line: number): number;
  onGo(position: Position): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => input.current?.focus(), []);
  const target = parseGoTo(value, props.lineCount, props.lineLength);
  return (
    <div
      role="search"
      aria-label="Go to line"
      className="flex h-9 shrink-0 items-center gap-2 border-b bg-popover px-2"
    >
      <input
        ref={input}
        aria-label="Go to line"
        placeholder="line[:column]"
        value={value}
        spellCheck={false}
        inputMode="numeric"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (target) props.onGo(target);
          }
        }}
        className="h-6 w-40 min-w-0 rounded-sm border border-border bg-background px-1.5 text-ui text-foreground outline-none placeholder:text-subtle-foreground focus-visible:border-ring"
      />
      <span aria-live="polite" className="text-xs text-subtle-foreground">
        {target
          ? `Line ${target.line + 1}, column ${target.column + 1}`
          : `Type a line from 1 to ${props.lineCount}`}
      </span>
    </div>
  );
}
