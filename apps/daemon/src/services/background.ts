import { logBackgroundFailure } from "../sqlite-failure.ts";
import type { ServiceContext } from "./types.ts";

/**
 * The failure handler of one background task (maintenance, discovery, cleanup). It logs and
 * never rethrows: a failed pass, even of a full disk, must not stop the daemon.
 */
export function backgroundFailure(
  context: Pick<ServiceContext, "log" | "config" | "options">,
  message: string,
): (error: unknown) => void {
  return (error) =>
    logBackgroundFailure(
      context.log,
      message,
      error,
      context.config.dataDir,
      context.options.diskSpace,
    );
}
