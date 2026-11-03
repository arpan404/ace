import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SearchField } from "@/components/search-field.tsx";
import { useDebouncedValue } from "@/lib/debounced.ts";

/** GitHub's search allows 30 requests a minute: let typing settle before asking. */
const settleMs = 300;

/**
 * The list's search line, prefilled with its filters as qualifiers (`is:pr is:open`). Enter
 * applies the line; plain words typed after the qualifiers search as they settle, so typing a
 * qualifier half way never asks GitHub for it. A change made elsewhere (a toggle, a menu)
 * rewrites the line. ⌘F focuses it.
 */
export function QueryField(props: {
  label: string;
  placeholder?: string | undefined;
  /** The filters on show, as a line. */
  value: string;
  /** A line as the filters it sets would write it, to tell a real change from spacing. */
  lineOf(text: string): string;
  /** The line may apply while typing: only its plain words changed. */
  settles(text: string): boolean;
  onApply(text: string): void;
}) {
  const { value } = props;
  // The page's functions change every render; the line reacts to the filters and the text only.
  const page = useRef(props);
  const [text, setText] = useState(value ? `${value} ` : "");
  const input = useRef<HTMLInputElement | null>(null);
  const settled = useDebouncedValue(text, settleMs);
  const latest = useRef(text);
  useLayoutEffect(() => {
    page.current = props;
    latest.current = text;
  });
  // The filters changed elsewhere: the line says them, unless it already means them.
  useEffect(() => {
    if (page.current.lineOf(latest.current) !== value) setText(value ? `${value} ` : "");
  }, [value]);
  useEffect(() => {
    const { lineOf, settles, onApply } = page.current;
    if (lineOf(settled) === value || !settles(settled)) return;
    onApply(settled);
  }, [settled, value]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey) || event.shiftKey)
        return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <SearchField
      ref={input}
      label={props.label}
      placeholder={props.placeholder ?? "Search all"}
      value={text}
      onValueChange={setText}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        props.onApply(text);
      }}
      className="h-8 min-w-0 flex-1 basis-64 border border-border bg-background"
    />
  );
}
