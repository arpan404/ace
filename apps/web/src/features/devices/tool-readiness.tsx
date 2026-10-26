import type { Toolchain } from "@ace/protocol";
import { Fragment } from "react";
import { ToolchainHints, useToolchains } from "@/features/diagnostics/index.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";

/** One tool as the readiness line names it: "Xcode 26.0", "serve-sim 0.1.48", "Android SDK". */
function toolWords(tool: Toolchain): string | undefined {
  switch (tool.id) {
    case "xcode":
      return tool.available ? `Xcode${tool.version ? ` ${tool.version}` : ""}` : "Xcode missing";
    case "serve-sim":
      // ace downloads its own serve-sim with the device tools.
      return tool.available
        ? `serve-sim${tool.version ? ` ${tool.version}` : ""}`
        : "serve-sim not downloaded";
    case "android":
      return tool.available
        ? `Android SDK${tool.version ? ` ${tool.version}` : ""}`
        : "Android SDK";
    default:
      return undefined;
  }
}

/**
 * One quiet line at the end of the list: the device tools on this machine and their versions,
 * with "Set up…" when one is missing, which opens the setup guidance.
 */
export function ToolReadiness(props: { onSetUp(): void }) {
  const tools = useToolchains();
  const shown = (tools.data ?? []).flatMap((tool) => {
    const words = toolWords(tool);
    return words ? [{ tool, words }] : [];
  });
  if (!shown.length) return null;
  const missing = shown.some(({ tool }) => !tool.available && tool.id !== "serve-sim");
  return (
    <p
      aria-label="Device tools"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-subtle-foreground"
    >
      {shown.map(({ tool, words }, index) => (
        <Fragment key={tool.id}>
          {index > 0 && <span aria-hidden>·</span>}
          <span className="tabular-nums">{words}</span>
        </Fragment>
      ))}
      {missing && (
        <button
          type="button"
          onClick={props.onSetUp}
          className="rounded-xs text-link focus-ring hover:underline"
        >
          Set up…
        </button>
      )}
    </p>
  );
}

/** The device tools and how to install the missing ones (the existing guidance). */
export function ToolSetupDialog(props: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Device tools</DialogTitle>
          <DialogDescription>
            Simulators need Xcode; emulators need the Android SDK. Install what's missing, then
            refresh the list.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <ToolchainHints devices />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
