import type { PluginReviewEntry } from "@ace/protocol";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useAcceptPlugin, type PreparedPlugin } from "./skills-source.ts";

const failure = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

function describe(entry: PluginReviewEntry): { title: string; detail: string } {
  if (entry.type === "diagnostic") return { title: "Note", detail: entry.message };
  const execution = entry.execution;
  switch (execution.kind) {
    case "hook":
      return { title: `Hook on ${execution.event}`, detail: execution.command };
    case "stdio":
      return {
        title: `MCP server ${execution.name}`,
        detail: [execution.command, ...execution.args].join(" "),
      };
    case "remote":
      return { title: `Remote MCP ${execution.name}`, detail: execution.url };
  }
}

/**
 * The trust review, shared by Install and Update: the exact pin, where it came from and what it
 * runs on this machine. Install has focus; Back drops the pin.
 */
export function PluginReviewStep(props: {
  prepared: PreparedPlugin;
  action?: "Accept changes";
  onAcceptingChange?(pending: boolean): void;
  /** "getsentry/sentry @ main", when known. */
  from?: string | undefined;
  onBack(): void;
  /** Accepted: the daemon installed exactly this pin. */
  onInstalled(name: string): void | Promise<void>;
}) {
  const { review, entries } = props.prepared;
  const accept = useAcceptPlugin();
  const install = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string>();
  // A new step: focus goes to Install, not back to the dialog's frame.
  useEffect(() => install.current?.focus(), []);
  const run = async () => {
    props.onAcceptingChange?.(true);
    try {
      await accept.mutateAsync(review);
      await props.onInstalled(review.name);
    } catch (reason) {
      setError(failure(reason, "The plugin didn't install."));
    } finally {
      props.onAcceptingChange?.(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>
          Review {review.name} {review.version}
        </DialogTitle>
        <DialogDescription>
          {props.from && `From ${props.from}. `}
          {review.executionCount
            ? "Once enabled it runs the commands below on this computer."
            : "It contains prompts only."}
          {review.unsupportedCount > 0 &&
            ` ${review.unsupportedCount} part${review.unsupportedCount === 1 ? "" : "s"} ace can't load will be skipped.`}
        </DialogDescription>
      </DialogHeader>
      {entries.length > 0 && (
        <DialogBody>
          <ul aria-label="What it runs">
            {entries.map((entry) => {
              const { title, detail } = describe(entry);
              return (
                <li
                  key={`${title}\u0000${detail}`}
                  className="border-t py-2 text-ui first:border-t-0"
                >
                  <div className="font-medium">{title}</div>
                  <code className="text-sm break-all text-muted-foreground">{detail}</code>
                </li>
              );
            })}
          </ul>
        </DialogBody>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={props.onBack} disabled={accept.isPending}>
          Back
        </Button>
        <Button
          ref={install}
          variant="primary"
          disabled={accept.isPending}
          onClick={() => void run()}
        >
          {accept.isPending ? "Saving…" : (props.action ?? "Install")}
        </Button>
      </DialogFooter>
    </div>
  );
}
