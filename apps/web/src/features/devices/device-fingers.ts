import type { DeviceInput } from "@ace/protocol";
import type { TouchInput } from "@/lib/touch-gestures.ts";

type Pointer = Extract<DeviceInput, { kind: "pointer" }>;
type Point = { x: number; y: number };

/**
 * The fingers a device holds, kept in step with the touch points a gesture reader
 * (`TouchGestures`) reports: each change becomes the device's own pointer events, a `down` for
 * a new finger, a `move` for one that moved and an `up` for one that lifted. `multi` devices get
 * every finger by `pointerId`; a one-finger device gets the first finger only. Pure.
 */
export class DeviceFingers {
  readonly #held = new Map<number, Point>();
  readonly #multi: boolean;
  constructor(multi: boolean) {
    this.#multi = multi;
  }
  /** Fingers the device holds now. */
  get held(): number {
    return this.#held.size;
  }
  /** The inputs that take the device from the fingers it holds to `touch`'s points. */
  touch(touch: TouchInput): Pointer[] {
    if (touch.event === "touchCancel") return this.cancel();
    const points = new Map<number, Point>();
    for (const point of touch.points)
      if (this.#multi || point.id === 0) points.set(point.id, { x: point.x, y: point.y });
    const inputs: Pointer[] = [];
    for (const [id, at] of this.#held)
      if (!points.has(id)) {
        this.#held.delete(id);
        inputs.push(this.#input("up", id, at));
      }
    for (const [id, at] of points) {
      const before = this.#held.get(id);
      this.#held.set(id, at);
      if (!before) inputs.push(this.#input("down", id, at));
      else if (before.x !== at.x || before.y !== at.y) inputs.push(this.#input("move", id, at));
    }
    return inputs;
  }
  /** Lift every finger without a gesture (the view lost the pointer, or control). */
  cancel(): Pointer[] {
    const inputs = [...this.#held].map(([id, at]) => this.#input("cancel", id, at));
    this.#held.clear();
    return inputs;
  }
  #input(phase: Pointer["phase"], id: number, at: Point): Pointer {
    return { kind: "pointer", phase, x: at.x, y: at.y, ...(this.#multi ? { pointerId: id } : {}) };
  }
}

const clamp = (value: number, size: number) =>
  Math.max(0, Math.min(Math.max(0, Math.floor(size - 1)), Math.round(value)));

/**
 * The second finger of a pinch made with a mouse (Option held, as in Simulator): the pointer's
 * mirror through the middle of the screen, so dragging out spreads both fingers apart.
 */
export function pinchPartner(at: Point, screen: { width: number; height: number }): Point {
  return {
    x: clamp(screen.width - 1 - at.x, screen.width),
    y: clamp(screen.height - 1 - at.y, screen.height),
  };
}
