import { z } from "zod";

/**
 * A persisted store under ACE_HOME is in a format this build does not read.
 *
 * ace is pre-release and carries no migrations for older formats (AGENTS.md), so recovery
 * means setting the old data aside. The daemon stops on this error with one message and
 * its own exit code, instead of starting with the store, and every service that needs it,
 * degraded.
 */
export class IncompatibleDataError extends Error {
  readonly code = "incompatible-data";
  readonly path: string;
  /**
   * `detail` says what is wrong; `recovery` says what the person can do. The default suits a
   * file the daemon recreates on start.
   */
  constructor(
    path: string,
    detail: string,
    recovery = "Quit ace, move that file aside, then start ace again to create it fresh.",
  ) {
    super(
      `${path}: ${detail}. A different ace build wrote it, and this build cannot read it. ${recovery}`,
    );
    this.name = "IncompatibleDataError";
    this.path = path;
  }
}

const Fields = z.object({
  code: z.literal("incompatible-data"),
  path: z.string(),
  message: z.string(),
});

/** Recognises the error after a worker boundary, which keeps its fields but not its class. */
export function incompatibleData(error: unknown): { path: string; message: string } | undefined {
  const fields = Fields.safeParse(error);
  return fields.success ? { path: fields.data.path, message: fields.data.message } : undefined;
}
