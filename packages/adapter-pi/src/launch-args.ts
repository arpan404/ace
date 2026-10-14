import { z } from "zod";
import { piNative, piReadOnlyTools } from "@ace/provider-kit/access-modes";

/** Pi's `--thinking` levels (pi --help, 1.2.0). */
export const PiThinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Native Pi flags for an access mode and effort. Read-only is Pi's own tool allowlist; Full
 * access (or no selection) leaves Pi's default tools. An unknown selector is refused rather
 * than run unrestricted.
 */
export function piLaunchArgs(mode: string | undefined, effort: unknown): string[] {
  const args: string[] = [];
  if (mode === piNative.readOnly) args.push("--tools", piReadOnlyTools.join(","));
  else if (mode !== undefined && mode !== piNative.unrestricted)
    throw new Error(`Pi cannot run the permission mode ${mode}`);
  if (effort !== undefined && effort !== null) args.push("--thinking", PiThinking.parse(effort));
  return args;
}
