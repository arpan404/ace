import { z } from "zod";
import { CliTaskStatus, CliTree } from "./cli-control.ts";
import { CliCommandHelp, CliCommandTree, CliVersionOutput } from "./cli-output.ts";
import { DaemonHealth } from "./release.ts";
import { cliAccessOutputs } from "./cli-outputs-access.ts";

/**
 * Each command's `--json` success value, by the `output` key in the CLI's command table
 * (ADR 0176 §3). `ace help COMMAND --schema` prints one as JSON Schema. Adding a field is not
 * a breaking change; renaming or removing one goes through the CLI's deprecation window.
 */

/** `ace thread start` (`ace run`): the thread was admitted. */
export const CliAdmission = z.object({
  type: z.literal("admission"),
  ok: z.literal(true),
  status: z.literal("accepted"),
  commandId: z.string(),
  idempotencyKey: z.string(),
  threadId: z.string(),
});
export type CliAdmission = z.infer<typeof CliAdmission>;

/** A mutation's receipt: the daemon accepted it, under this idempotency key. */
export const CliReceipt = z.object({ ok: z.boolean(), idempotencyKey: z.string() }).loose();

export const CliDaemonStart = z.object({
  running: z.literal(true),
  url: z.string(),
  tokenPath: z.string(),
  remoteUrl: z.string().optional(),
  fingerprint: z.string().optional(),
});

export const CliDaemonDown = z.object({ running: z.literal(false) });

export const cliOutputs = {
  help: z.union([CliCommandTree, CliCommandHelp]),
  version: CliVersionOutput,
  status: z.union([DaemonHealth.loose(), CliDaemonDown]),
  "daemon.status": z.union([DaemonHealth.loose(), CliDaemonDown]),
  "daemon.start": CliDaemonStart,
  "daemon.stop": z.object({ stopped: z.boolean() }).loose(),
  "thread.start": CliAdmission,
  "thread.wait": CliTree,
  "thread.status": CliTaskStatus,
  receipt: CliReceipt,
  ...cliAccessOutputs,
} satisfies Record<string, z.ZodType>;
