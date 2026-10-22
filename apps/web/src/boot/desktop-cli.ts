import { z } from "zod";

/*
 * The `ace` command on this computer's terminal PATH, which the desktop app installs and puts
 * there (`window.ace.cli`). Nothing in a browser. Everything the bridge returns is parsed here.
 */

const LongPath = z.string().min(1).max(4096);
/** `TerminalCommand` from the desktop's contract (apps/desktop/src/shared/contract.ts). */
export const TerminalCommand = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), command: LongPath }),
  z.object({ state: z.literal("added"), files: z.array(LongPath).min(1).max(8) }),
  z.object({ state: z.literal("off"), command: LongPath }),
  z.object({ state: z.literal("other"), command: LongPath }),
  z.object({
    state: z.literal("manual"),
    directory: LongPath,
    reason: z.string().max(2000).optional(),
  }),
  z.object({ state: z.literal("unavailable"), reason: z.string().max(2000) }),
]);
export type TerminalCommand = z.infer<typeof TerminalCommand>;

export interface DesktopCli {
  status(): Promise<TerminalCommand>;
  setOnPath(on: boolean): Promise<TerminalCommand>;
}

/** The desktop's `ace` command controls; undefined in a browser or an older desktop build. */
export function desktopCli(scope: object = globalThis): DesktopCli | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (typeof ace !== "object" || ace === null || !("cli" in ace)) return undefined;
  const cli: unknown = ace.cli;
  if (typeof cli !== "object" || cli === null) return undefined;
  const status: unknown = Reflect.get(cli, "status");
  const setOnPath: unknown = Reflect.get(cli, "setOnPath");
  if (typeof status !== "function" || typeof setOnPath !== "function") return undefined;
  return {
    status: async () => TerminalCommand.parse(await Reflect.apply(status, cli, [])),
    setOnPath: async (on) => TerminalCommand.parse(await Reflect.apply(setOnPath, cli, [on])),
  };
}
