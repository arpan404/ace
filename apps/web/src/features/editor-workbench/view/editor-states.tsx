import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import type { BufferStatus } from "../buffers/index.ts";
import { fileName } from "./paths.ts";

/** Spec 62: the last group with nothing open. The explorer beside it is the real way in. */
export function NoFileOpen(props: { onQuickOpen?: (() => void) | undefined }) {
  return (
    <EmptyState
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

/** The registry states that show a line instead of the editor. */
export type ProblemStatus = Extract<BufferStatus, { kind: "missing" | "unreadable" | "failed" }>;

/** Spec 65's one line for a file the editor can't take (W2 passes the Files read's kind). */
export function problemLine(path: string, status: ProblemStatus): string {
  const name = fileName(path);
  if (status.kind === "missing") return "This file was deleted.";
  if (status.kind === "failed") return `Couldn't open ${name}. ${status.message}`;
  if (status.reason === "binary") return `${name} is a binary file.`;
  if (status.reason === "large") return `${name} is too large to edit here.`;
  if (status.reason === "media" || status.reason === "image") return `${name} is a media file.`;
  return `Couldn't read ${name}.`;
}

/**
 * Spec 14 and 65: a file that can't be shown says what, in one line, with the way out: Close
 * for a deleted file, Try again for a failed read.
 */
export function FileProblem(props: {
  path: string;
  status: ProblemStatus;
  onClose(): void;
  onRetry(): void;
}) {
  const { status } = props;
  return (
    <div
      role="status"
      className="flex flex-1 items-start gap-3 px-3.5 pt-4 text-ui text-muted-foreground"
    >
      <span>{problemLine(props.path, status)}</span>
      {status.kind === "missing" && (
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      )}
      {status.kind === "failed" && (
        <Button size="sm" variant="ghost" onClick={props.onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
