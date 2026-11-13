import type { AgentPointer, AgentPointerKind } from "@ace/protocol";
import {
  PersonPresence,
  personQuietMs,
  personWaitMs,
  waitedNote,
  type PresenceClock,
  type PresenceTiming,
} from "@ace/interaction/presence";

/*
 * Cowork on the screen (ADR 0143): the person and agents use the same apps at once. Each app is
 * one surface, keyed by its bundle id (the process name on Windows and Linux). The person's
 * input there, routed through ace's live view or (on macOS and Windows) typed on the machine
 * while that app is frontmost, extends their lease; an agent's action in that app waits for it.
 */

export interface ScreenCoworkOptions {
  clock: PresenceClock;
  /** Epoch milliseconds for pointer protocol timestamps; leases use only `clock`. */
  epochNow?: () => number;
  timing?: PresenceTiming;
  /**
   * The machine's own input: when the person last touched the keyboard or mouse (clock ms), and
   * the app frontmost now. Undefined where ace can't tell (Linux): only routed input counts.
   */
  physical?: PhysicalInput;
}

export interface PhysicalInput {
  /** Clock ms of the last keyboard or mouse event on this machine, or undefined if unknown. */
  lastInputAt(): Promise<number | undefined>;
  /** The frontmost app's bundle id (process name off macOS), or undefined if unknown. */
  frontmost(): Promise<string | undefined>;
}

/** The result of an agent waiting on an app: how long, and whether it gave up. */
export interface ScreenYield {
  busy: boolean;
  waitedMs: number;
  /** The line the action's result carries when it waited, else undefined. */
  note: string | undefined;
}

const surfaceOf = (app: string) => `app:${app}`;
const appOf = (surface: string) => (surface.startsWith("app:") ? surface.slice(4) : undefined);

export class ScreenCowork {
  private readonly presence: PersonPresence;
  private readonly clock: PresenceClock;
  private readonly epochNow: () => number;
  private readonly maxWaitMs: number;
  private readonly sample: ((surface: string) => Promise<number | undefined>) | undefined;
  private readonly listeners = new Set<(app: string) => void>();
  private readonly pointers = new Map<string, AgentPointer>();
  constructor(options: ScreenCoworkOptions) {
    this.clock = options.clock;
    this.epochNow = options.epochNow ?? options.clock.now;
    this.maxWaitMs = options.timing?.maxWaitMs ?? personWaitMs;
    const physical = options.physical;
    this.sample = physical
      ? async (surface) => {
          const at = await physical.lastInputAt();
          if (
            at === undefined ||
            this.clock.now() - at >= (options.timing?.quietMs ?? personQuietMs)
          )
            return undefined;
          return (await physical.frontmost()) === appOf(surface) ? at : undefined;
        }
      : undefined;
    this.presence = new PersonPresence({
      clock: options.clock,
      ...(options.timing ? { timing: options.timing } : {}),
      changed: (surface) => {
        const app = appOf(surface);
        if (app) this.tell(app);
      },
      ...(this.sample ? { sample: this.sample } : {}),
    });
  }

  /** The person's input reached these apps through ace (live view, ui.act). */
  personInput(apps: readonly string[]): void {
    for (const app of apps) this.presence.input(surfaceOf(app));
  }

  /** The person used one of these apps within the quiet window. */
  personActive(apps: readonly string[]): boolean {
    return apps.some((app) => this.presence.active(surfaceOf(app)));
  }

  /**
   * Waits while the person uses `app`, at most a minute. `name` is how the note names it
   * ("Safari"). An abort rejects with the signal's reason.
   */
  async yield(app: string, name: string, signal?: AbortSignal): Promise<ScreenYield> {
    const result = await this.presence.yield(surfaceOf(app), signal);
    return { ...result, note: result.busy ? undefined : waitedNote(result.waitedMs, name) };
  }

  /** One request's deadline and accumulated waits, kept across queue retries. */
  turn(
    apps: readonly string[],
    name = apps[0] ?? "this app",
  ): {
    wait(signal?: AbortSignal): Promise<ScreenYield>;
    ready(): Promise<boolean>;
    busy(): boolean;
  } {
    const deadline = this.clock.now() + this.maxWaitMs;
    let waitedMs = 0;
    const result = (busy: boolean): ScreenYield => ({
      busy,
      waitedMs,
      note: busy ? undefined : waitedNote(waitedMs, name),
    });
    // Sampling reads native input once; it never sleeps while a dispatch slot is held.
    const ready = async () => {
      await Promise.all(
        apps.map(async (app) => {
          const surface = surfaceOf(app);
          try {
            const at = await this.sample?.(surface);
            if (at !== undefined) this.presence.input(surface, at);
          } catch {
            // An unavailable native source leaves routed input authoritative.
          }
        }),
      );
      return !this.personActive(apps);
    };
    return {
      ready,
      busy: () => this.personActive(apps),
      wait: async (signal) => {
        signal?.throwIfAborted();
        const left = deadline - this.clock.now();
        if (left <= 0) {
          const available = await ready();
          signal?.throwIfAborted();
          return result(!available);
        }
        const began = this.clock.now();
        const controller = new AbortController();
        const waiting = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const expired = Symbol("person wait expired");
        const cancel = this.clock.set(left, () => controller.abort(expired));
        try {
          const outcomes = await Promise.all(
            apps.map((app) => this.presence.yield(surfaceOf(app), waiting)),
          );
          waitedMs += this.clock.now() - began;
          return result(outcomes.some((outcome) => outcome.busy));
        } catch (error) {
          if (error !== expired) throw error;
          waitedMs += this.clock.now() - began;
          return result(true);
        } finally {
          cancel();
        }
      },
    };
  }

  /** The agent acted in `app`; with a point, viewers draw its cursor there. */
  acted(app: string, point: { x: number; y: number } | undefined, kind: AgentPointerKind): void {
    if (!point) return;
    this.pointers.set(app, {
      x: Math.round(point.x),
      y: Math.round(point.y),
      kind,
      at: Math.max(0, Math.round(this.epochNow())),
    });
    this.tell(app);
  }

  /** The agent's latest point in any of these apps. */
  pointer(apps: readonly string[]): AgentPointer | undefined {
    let latest: AgentPointer | undefined;
    for (const app of apps) {
      const pointer = this.pointers.get(app);
      if (pointer && (!latest || pointer.at >= latest.at)) latest = pointer;
    }
    return latest;
  }

  /** Told with an app whose person activity or agent pointer changed. */
  subscribe(listener: (app: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private tell(app: string): void {
    for (const listener of this.listeners) {
      try {
        listener(app);
      } catch {
        /* A viewer can't change what the agent may do. */
      }
    }
  }
}
