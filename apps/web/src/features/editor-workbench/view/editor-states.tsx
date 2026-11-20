import { FilesIcon } from "@ace/icons";
import { useEffect, useState } from "react";
import { pinnedGlyph } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { formatBytes } from "@/components/format-bytes.ts";
import type { BufferLoad } from "./buffers.ts";
import { fileName } from "./paths.ts";

// Empty states draw their glyph two-tone (components/empty-glyphs.ts).
const filesGlyph = pinnedGlyph(FilesIcon, ["duotone"]);

/** Spec 62: the last group with nothing open. The explorer beside it is the real way in. */
export function NoFileOpen(props: { onQuickOpen?: (() => void) | undefined }) {
  return (
    <EmptyState
      icon={filesGlyph}
      title="No file open"
      action={
        props.onQuickOpen && (
          <Button size="sm" variant="ghost" onClick={props.onQuickOpen}>
            Open a file <Kbd shortcut="files" />
          </Button>
        )
      }
    />
  );
}

/** Spec 64: skeleton lines at code width, only after 150 ms, never a spinner. */
export function LoadingLines(props: { delayMs?: number }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), props.delayMs ?? 150);
    return () => clearTimeout(timer);
  }, [props.delayMs]);
  if (!shown) return <div className="flex-1" aria-busy="true" aria-label="Loading file" />;
  const widths = ["42%", "68%", "55%", "30%", "74%", "61%", "22%", "48%"];
  return (
    <div
      className="flex flex-1 flex-col gap-2.5 pt-3 pl-14"
      aria-busy="true"
      aria-label="Loading file"
    >
      {widths.map((width, index) => (
        <span
          key={width}
          aria-hidden
          className="fx-skeleton block h-2.5"
          style={{ width, animationDelay: `${index * 60}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * Spec 14 and 65: a file that can't be shown says what, in one line, with the way out.
 * The editor host passes the handlers it supports; a missing one hides its button.
 */
export function FileProblem(props: {
  path: string;
  load: Exclude<BufferLoad, { state: "loading" } | { state: "ready" }>;
  onRestore?: (() => void) | undefined;
  onClose(): void;
  onOpenReadOnly?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const name = fileName(props.path);
  const { load } = props;
  const line =
    load.state === "deleted"
      ? "This file was deleted."
      : load.state === "binary"
        ? `${name} is a binary file.`
        : load.state === "too-large"
          ? `${name} is ${formatBytes(load.bytes)}, too large to edit here.`
          : `Couldn't read ${name}. ${load.reason}`;
  return (
    <div
      role="status"
      className="flex flex-1 items-start gap-3 px-3.5 pt-4 text-ui text-muted-foreground"
    >
      <span>{line}</span>
      {load.state === "deleted" && load.restorable && props.onRestore && (
        <Button size="sm" variant="ghost" onClick={props.onRestore}>
          Restore
        </Button>
      )}
      {load.state === "deleted" && (
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      )}
      {load.state === "too-large" && props.onOpenReadOnly && (
        <Button size="sm" variant="ghost" onClick={props.onOpenReadOnly}>
          Open read only
        </Button>
      )}
      {load.state === "unreadable" && props.onRetry && (
        <Button size="sm" variant="ghost" onClick={props.onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
