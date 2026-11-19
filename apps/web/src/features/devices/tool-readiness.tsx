import type { Toolchain } from "@ace/protocol";
import { Fragment } from "react";
import { useToolchains } from "@/features/diagnostics/index.ts";
import { Link } from "@tanstack/react-router";

/** One tool as the readiness line names it: "Xcode 26.0", "serve-sim 0.1.49-beta.139.1", "Android SDK". */
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
 * with "Set up…" when one is missing, which opens the tools in Settings › Simulators.
 */
export function ToolReadiness() {
  const tools = useToolchains();
  const shown = (tools.data ?? []).flatMap((tool) => {
    const words = toolWords(tool);
    return words ? [{ tool, words }] : [];
  });
  if (!shown.length) return null;
  const missing = shown.some(({ tool }) => !tool.available);
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
        <Link
          to="/settings/simulators"
          hash="tools"
          className="rounded-xs text-link focus-ring hover:underline"
        >
          Set up…
        </Link>
      )}
    </p>
  );
}
