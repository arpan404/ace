import type { DeviceInput } from "@ace/protocol/devices";
import type { RawSupervisedProcess } from "@ace/provider-kit/process";
import type { DeviceRuntime } from "./runtime.ts";
import { DeviceError } from "./sdk.ts";

/** One native touch and keyboard operation, revoked synchronously when control changes. */
export class SimulatorInput {
  private epoch = new AbortController();
  private held: { x: number; y: number; edge: number; epoch: AbortController } | undefined;
  private typing: RawSupervisedProcess | undefined;
  private cleanup: Promise<void> = Promise.resolve();
  private readonly options: {
    runtime: DeviceRuntime;
    command: string;
    device: string;
    env: NodeJS.ProcessEnv;
    dimensions(): { width: number; height: number };
    orientation(): string;
    send(tag: number, payload: unknown, cleanup?: boolean): void;
  };
  constructor(options: SimulatorInput["options"]) {
    this.options = options;
  }
  release(): Promise<void> {
    this.epoch.abort();
    let failure: unknown;
    try {
      this.end(this.epoch);
    } catch (error) {
      failure = error;
    }
    this.epoch = new AbortController();
    const typing = this.typing;
    this.cleanup = Promise.all([this.cleanup, typing?.stop({ graceMs: 0 })]).then(() => {
      if (failure) throw failure;
    });
    return this.cleanup;
  }
  private end(epoch: AbortController) {
    const held = this.held;
    if (!held || held.epoch !== epoch) return;
    this.options.send(3, touchMessage("end", held), true);
    this.held = undefined;
  }
  async input(input: DeviceInput, guard: () => void): Promise<void> {
    const epoch = this.epoch;
    await this.cleanup;
    const check = () => {
      epoch.signal.throwIfAborted();
      guard();
    };
    check();
    const touch = (type: "begin" | "move", x: number, y: number, gesture = false) => {
      check();
      const { width, height } = this.options.dimensions();
      if (!width || !height || x < 0 || y < 0 || x >= width || y >= height)
        throw new Error("Simulator input is outside the current frame");
      const point = { x: x / width, y: y / height };
      // A drag that starts on a screen edge is a system edge gesture (home, Control Centre).
      const edge =
        type === "begin" ? (gesture ? screenEdge(point.x, point.y) : 0) : (this.held?.edge ?? 0);
      const held = { ...point, edge, epoch };
      this.options.send(3, touchMessage(type, held));
      this.held = held;
    };
    if (input.kind === "pointer") {
      if (input.phase === "down") {
        this.end(epoch);
        touch("begin", input.x, input.y, true);
      } else if (input.phase === "move") {
        if (!this.held) throw new Error("Simulator pointer is not held");
        touch("move", input.x, input.y);
      } else this.end(epoch);
      return;
    }
    if (input.kind === "tap" || input.kind === "swipe" || input.kind === "longPress") {
      this.end(epoch);
      touch("begin", input.x, input.y, input.kind === "swipe");
      try {
        if (input.kind !== "tap") {
          const steps = Math.max(1, Math.ceil(input.durationMs / 16));
          for (let step = 1; step <= steps; step++) {
            await this.sleep(input.durationMs / steps, epoch.signal);
            check();
            if (input.kind === "swipe")
              touch(
                "move",
                input.x + ((input.toX - input.x) * step) / steps,
                input.y + ((input.toY - input.y) * step) / steps,
              );
          }
        }
      } finally {
        this.end(epoch);
      }
      return;
    }
    if (input.kind === "key" && input.key !== "enter") {
      if (input.key === "rotate")
        this.options.send(7, {
          orientation: this.options.orientation() === "portrait" ? "landscape_left" : "portrait",
        });
      else if (input.key === "home") this.options.send(4, { button: "home" });
      else if (input.key === "power")
        this.options.send(4, { button: "power", page: 12, usage: 48 });
      else
        throw new DeviceError(
          "not_supported",
          "iOS has no Back key",
          "Use a gesture or the app's back control.",
        );
      return;
    }
    const typing = this.options.runtime.spawn({
      command: this.options.command,
      args: ["type", "--stdin", "-d", this.options.device],
      env: this.options.env,
      name: "simulator-keyboard",
    });
    this.typing = typing;
    typing.stdout.resume();
    typing.stderr.resume();
    const stop = () => {
      void typing.stop({ graceMs: 0 }).catch(() => {});
    };
    typing.stdin.on("error", stop);
    const timeout = this.options.runtime.after(10000, stop);
    epoch.signal.addEventListener("abort", stop, { once: true });
    try {
      check();
      typing.stdin.end(input.kind === "type" ? input.text : "\n");
      const exit = await typing.exited;
      check();
      if (exit.code !== 0)
        throw new DeviceError(
          "command_failed",
          "Simulator keyboard input failed",
          "serve-sim supports US keyboard text; check Simulator keyboard permissions.",
        );
    } finally {
      timeout();
      epoch.signal.removeEventListener("abort", stop);
      await typing.stop({ graceMs: 0 });
      if (this.typing === typing) this.typing = undefined;
    }
  }
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        cancel();
        reject(new DOMException("Simulator input cancelled", "AbortError"));
      };
      const cancel = this.options.runtime.after(ms, () => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

/** serve-sim's touch message; the edge field is sent only for edge gestures. */
function touchMessage(
  type: "begin" | "move" | "end",
  point: { x: number; y: number; edge: number },
) {
  return point.edge
    ? { type, x: point.x, y: point.y, edge: point.edge }
    : { type, x: point.x, y: point.y };
}

/**
 * The screen edge a normalized point lies on, as serve-sim's touch `edge` field names it:
 * 1 left, 2 top, 3 bottom, 4 right, 0 none. The band is 2% of the screen.
 */
export function screenEdge(x: number, y: number): number {
  const band = 0.02;
  if (y >= 1 - band) return 3;
  if (y < band) return 2;
  if (x < band) return 1;
  if (x >= 1 - band) return 4;
  return 0;
}
