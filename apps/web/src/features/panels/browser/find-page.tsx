import { useEffect, useRef, useState } from "react";
import type { PreviewSource } from "../sources.ts";
import { Input } from "@/components/ui/input.tsx";
import { Button } from "@/components/ui/button.tsx";

export function FindPage(props: { source: PreviewSource; threadId: string; onClose(): void }) {
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const find = async (forward: boolean) => {
    const current = ++generation.current;
    try {
      const raw = await props.source.findText?.(props.threadId, text, forward);
      if (current !== generation.current) return;
      if (
        typeof raw === "object" &&
        raw !== null &&
        "matches" in raw &&
        typeof raw.matches === "number"
      )
        setMessage(
          "active" in raw && typeof raw.active === "number" && raw.matches > 0
            ? `${raw.active} of ${raw.matches}`
            : `${raw.matches} ${raw.matches === 1 ? "match" : "matches"}`,
        );
      else if (typeof raw === "object" && raw !== null && "found" in raw)
        setMessage(raw.found ? "Match found" : "No matches");
    } catch (error) {
      if (current === generation.current)
        setMessage(error instanceof Error ? error.message : "Find failed");
    }
  };
  useEffect(() => {
    if (!text) return;
    const timer = setTimeout(() => void find(true), 200);
    return () => clearTimeout(timer); // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  useEffect(
    () => () => {
      generation.current++;
      void props.source.findText?.(props.threadId, "", true).catch(() => {});
    },
    [props.source, props.threadId],
  );
  return (
    <div
      role="search"
      aria-label="Find in page"
      className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
    >
      <Input
        aria-label="Find text"
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void find(!event.shiftKey);
          }
          if (event.key === "Escape") props.onClose();
        }}
      />
      <span role="status" className="shrink-0 text-xs text-muted-foreground">
        {message}
      </span>
      <Button size="sm" variant="ghost" onClick={() => void find(false)}>
        Previous
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void find(true)}>
        Next
      </Button>
      <Button size="sm" variant="ghost" onClick={props.onClose}>
        Close find
      </Button>
    </div>
  );
}
