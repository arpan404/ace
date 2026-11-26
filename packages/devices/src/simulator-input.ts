import type { DeviceInput } from "@ace/protocol/devices";
import type { RawSupervisedProcess } from "@ace/provider-kit/process";
import type { DeviceRuntime } from "./runtime.ts";
import { refuseSimulatorKey } from "./key-support.ts";
import {
  nativeInput,
  nativeKeyAction,
  nativeNormalizedPoint,
  nativeScreenEdge,
} from "./native-input.ts";
import { nativeDevices } from "./native-devices-addon.ts";
import { DeviceError } from "./sdk.ts";
import {
  endFingers,
  fingerDown,
  fingerMove,
  fingerUp,
  noFingers,
  simulatorFinger,
  type FingerMessage,
  type FingerPoint,
  type FingerStep,
  type HeldFingers,
} from "./simulator-fingers.ts";

/**
 * Simulator hardware buttons as HID (usage page, usage), the codes Xcode's DeviceKit chrome
 * gives each button; serve-sim presses a button sent with both. Consumer page 0x0C: Sleep/Wake
 * 0x30, Volume Up 0xE9, Volume Down 0xEA, and 0x95 for Apple Watch's side button. Telephony
 * page 0x0B, usage 0x2D: the Action button.
 */
const hardwareButtons = {
  power: { page: 12, usage: 48 },
  volumeUp: { page: 12, usage: 233 },
  volumeDown: { page: 12, usage: 234 },
  action: { page: 11, usage: 45 },
  side: { page: 12, usage: 149 },
} as const;

/**
 * serve-sim's HID tag for a press of Simulator's I/O ▸ Keyboard ▸ Toggle Software Keyboard (⌘K):
 * Indigo button source 0x3f0. It flips iOS between its on-screen keyboard and hardware-keyboard
 * mode, and leaves Simulator's Connect Hardware Keyboard setting alone.
 */
const softwareKeyboardToggle = 12;
/**
 * serve-sim's typing exits before iOS has handled every key it sent, and a key handled after the
 * toggle puts iOS back into hardware-keyboard mode. Measured on iOS 26.5: a toggle sent at once
 * lost the keyboard after 44 characters; one sent 250 ms later kept it after 150.
 */
const typingSettleMs = 250;

/** serve-sim's edge band for a normalized point, decided in ace-devices under the switch. */
function edge(x: number, y: number): number {
  return nativeInput ? nativeScreenEdge(x, y) : screenEdge(x, y);
}

/**
 * Native touch (one finger, or two as serve-sim's two-finger touch) and keyboard operations,
 * revoked synchronously when control changes.
 *
 * Typed text reaches iOS as HID keyboard keys, and any such key puts iOS into hardware-keyboard
 * mode: the on-screen keyboard hides and no later tap brings it back. So after ace types, the
 * keyboard is toggled back, unless the person hid it with the `keyboard` key themselves.
 */
export class SimulatorInput {
  /** Whether the person wants the on-screen keyboard; the `keyboard` key flips it. */
  private softwareKeyboard = true;
  private epoch = new AbortController();
  private held: { fingers: HeldFingers; epoch: AbortController } = {
    fingers: noFingers,
    epoch: this.epoch,
  };
  private typing: RawSupervisedProcess | undefined;
  private cleanup: Promise<void> = Promise.resolve();
  private readonly options: {
    runtime: DeviceRuntime;
    command: string;
    /** Arguments before serve-sim's own (ace's copy runs as `node <script>`). */
    commandArgs?: readonly string[];
    device: string;
    env: NodeJS.ProcessEnv;
    dimensions(): { width: number; height: number };
    orientation(): string;
    send(tag: number, payload: unknown, cleanup?: boolean): void;
    /**
     * Touches through Xcode's own input service when it can; false sends the touch to serve-sim.
     */
    touch?(message: FingerMessage): boolean;
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
    if (this.held.epoch !== epoch) return;
    this.apply(epoch, { held: noFingers, messages: endFingers(this.held.fingers) });
  }
  /** Sends a finger step's messages; lifting fingers is never held back by input backlog. */
  private apply(epoch: AbortController, step: FingerStep) {
    for (const message of step.messages)
      if (!this.options.touch?.(message))
        this.options.send(message.tag, message.payload, message.payload.type === "end");
    this.held = { fingers: step.held, epoch };
  }
  /** Fingers held under this control epoch; a revoked epoch's fingers were already lifted. */
  private fingers(epoch: AbortController): HeldFingers {
    return this.held.epoch === epoch ? this.held.fingers : noFingers;
  }
  async input(input: DeviceInput, guard: () => void): Promise<void> {
    const epoch = this.epoch;
    await this.cleanup;
    const check = () => {
      epoch.signal.throwIfAborted();
      guard();
    };
    check();
    const point = (x: number, y: number): FingerPoint => {
      check();
      const { width, height } = this.options.dimensions();
      // The frame check and the normalization are ace-devices' decision under the switch.
      if (nativeInput) return nativeNormalizedPoint(x, y, width, height);
      if (!width || !height || x < 0 || y < 0 || x >= width || y >= height)
        throw new Error("Simulator input is outside the current frame");
      return { x: x / width, y: y / height };
    };
    const touch = (type: "begin" | "move", x: number, y: number, gesture = false) => {
      const at = point(x, y);
      // A drag that starts on a screen edge is a system edge gesture (home, Control Centre).
      this.apply(
        epoch,
        type === "begin"
          ? fingerDown(noFingers, 0, at, gesture ? edge(at.x, at.y) : 0)
          : fingerMove(this.fingers(epoch), 0, at),
      );
    };
    if (input.kind === "pointer") {
      const finger = simulatorFinger(input.pointerId);
      const held = this.fingers(epoch);
      if (input.phase === "down") {
        const at = point(input.x, input.y);
        this.apply(epoch, fingerDown(held, finger, at, edge(at.x, at.y)));
      } else if (input.phase === "move")
        this.apply(epoch, fingerMove(held, finger, point(input.x, input.y)));
      else this.apply(epoch, fingerUp(held, finger));
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
    let typed: string | undefined = input.kind === "type" ? input.text : undefined;
    if (input.kind === "key") {
      if (nativeInput) {
        // The key's message, its refusal, or the line Return types: ace-devices decides.
        const action = nativeKeyAction(input.key, this.options.orientation());
        if (action.kind === "type") typed = action.text;
        else {
          // The person's keyboard preference is the shell's: the key flips it.
          if (input.key === "keyboard") this.softwareKeyboard = !this.softwareKeyboard;
          this.options.send(action.message.tag, action.message.payload);
          return;
        }
      } else if (input.key !== "enter") {
        if (input.key === "keyboard") {
          this.softwareKeyboard = !this.softwareKeyboard;
          this.options.send(softwareKeyboardToggle, {});
        } else if (input.key === "rotate")
          this.options.send(7, {
            orientation: this.options.orientation() === "portrait" ? "landscape_left" : "portrait",
          });
        else if (input.key === "home") this.options.send(4, { button: "home" });
        else if (input.key === "power")
          this.options.send(4, { button: "power", ...hardwareButtons.power });
        else if (
          input.key === "volumeUp" ||
          input.key === "volumeDown" ||
          input.key === "action" ||
          input.key === "side"
        )
          this.options.send(4, hardwareButtons[input.key]);
        else refuseSimulatorKey(input.key);
        return;
      } else typed = "\n";
    }
    const typing = this.options.runtime.spawn({
      command: this.options.command,
      // The typing arguments are ace-devices' decision under the switch.
      args: [
        ...(this.options.commandArgs ?? []),
        ...(nativeInput
          ? nativeDevices().devicePlatformTypingArgs(this.options.device)
          : ["type", "--stdin", "-d", this.options.device]),
      ],
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
      typing.stdin.end(typed ?? "");
      const exit = await typing.exited;
      check();
      if (exit.code !== 0)
        throw new DeviceError(
          "command_failed",
          "Simulator keyboard input failed",
          "serve-sim supports US keyboard text; check Simulator keyboard permissions.",
        );
      if (this.softwareKeyboard) {
        await this.sleep(typingSettleMs, epoch.signal);
        check();
        this.options.send(softwareKeyboardToggle, {});
      }
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
