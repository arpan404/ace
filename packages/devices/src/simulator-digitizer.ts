import { z } from "zod";
import type { RawSupervisedProcess } from "@ace/provider-kit/process";
import type { DeviceRuntime } from "./runtime.ts";
import type { FingerMessage } from "./simulator-fingers.ts";

/** One touch step for the screen helper's `--sim-touch` mode. */
export interface DigitizerStep {
  phase: "down" | "move" | "up";
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  edge: number;
  target: number;
}

const phases = { begin: "down", move: "move", end: "up" } as const;

/** A finger message (one finger, or two together) as the step the digitizer takes. */
export function digitizerStep(message: FingerMessage, target: number): DigitizerStep {
  const phase = phases[message.payload.type];
  if (message.tag === 3) {
    const { x, y, edge } = message.payload;
    return { phase, x, y, edge: edge ?? 0, target };
  }
  const { x1, y1, x2, y2 } = message.payload;
  return { phase, x: x1, y: y1, x2, y2, edge: 0, target };
}

/** Touches a Simulator through Xcode's own input service, while the helper runs. */
export interface SimulatorDigitizer {
  /** Sends the finger message; false when the helper is gone and the caller should fall back. */
  touch(message: FingerMessage): boolean;
  stop(): Promise<void>;
}

const Ready = z.object({ ready: z.literal(true) });

/**
 * Starts the screen helper's `--sim-touch` mode for `udid`. On Xcode 27 a Simulator's older
 * SimulatorKit touch service can drop out of iOS's event system and lose every touch; the
 * digitizer service Xcode's device tool uses doesn't. Resolves undefined when the helper can't
 * reach that service (an older Xcode, a helper without the mode), so touches stay on serve-sim.
 * A helper that dies later (the simulator shut down, its HID daemon restarted) is started again
 * on a later touch, at most once every few seconds; touches in between go to serve-sim.
 */
export async function startSimulatorDigitizer(options: {
  helper: string;
  udid: string;
  runtime: Pick<DeviceRuntime, "spawn" | "after" | "now">;
  env: NodeJS.ProcessEnv;
  /** The display the next touch belongs to. */
  target(): number;
}): Promise<SimulatorDigitizer | undefined> {
  const { runtime } = options;
  const first = await launch(options);
  if (!first) return undefined;
  let child: RawSupervisedProcess | undefined;
  // A helper that exits is let go at once, so no touch is written into a closing pipe.
  const adopt = (next: RawSupervisedProcess) => {
    child = next;
    void next.exited.then(() => {
      if (child === next) child = undefined;
    });
  };
  adopt(first);
  let stopped = false;
  let restarting = false;
  let lastStart = runtime.now();
  const restart = () => {
    if (restarting || stopped || runtime.now() - lastStart < 5000) return;
    restarting = true;
    lastStart = runtime.now();
    void launch(options)
      .then((next) => {
        if (stopped) void next?.stop({ graceMs: 0 }).catch(() => {});
        else if (next) adopt(next);
      })
      .finally(() => {
        restarting = false;
      });
  };
  return {
    touch(message) {
      const current = child;
      if (stopped || !current || !current.stdin.writable) {
        if (!stopped) restart();
        return false;
      }
      current.stdin.write(`${JSON.stringify(digitizerStep(message, options.target()))}\n`);
      return true;
    },
    async stop() {
      stopped = true;
      const current = child;
      child = undefined;
      if (!current) return;
      // Closing input lifts a held finger before the helper exits.
      current.stdin.end();
      await current.stop({ graceMs: 1000 }).catch(() => {});
    },
  };
}

/** A running `--sim-touch` helper that said it is ready, or undefined. */
async function launch(options: {
  helper: string;
  udid: string;
  runtime: Pick<DeviceRuntime, "spawn" | "after">;
  env: NodeJS.ProcessEnv;
}): Promise<RawSupervisedProcess | undefined> {
  const child = options.runtime.spawn({
    command: options.helper,
    args: ["--sim-touch", options.udid],
    env: options.env,
    name: "simulator-touch",
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const ready = Promise.withResolvers<boolean>();
  let output = "";
  const read = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    const end = output.indexOf("\n");
    if (end >= 0) {
      try {
        ready.resolve(Ready.safeParse(JSON.parse(output.slice(0, end))).success);
      } catch {
        ready.resolve(false);
      }
    } else if (output.length > 4096) ready.resolve(false);
  };
  child.stdout.on("data", read);
  void child.exited.then(() => ready.resolve(false));
  const cancel = options.runtime.after(3000, () => ready.resolve(false));
  const ok = await ready.promise;
  cancel();
  child.stdout.off("data", read);
  child.stdout.resume();
  if (ok) return child;
  await child.stop({ graceMs: 0 }).catch(() => {});
  return undefined;
}
