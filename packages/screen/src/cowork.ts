import type { AgentPointer, AgentPointerKind } from "@ace/protocol";
import {
  PersonPresence,
  personQuietMs,
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
  private readonly listeners = new Set<(app: string) => void>();
  private readonly pointers = new Map<string, AgentPointer>();
  constructor(options: ScreenCoworkOptions) {
    this.clock = options.clock;
    const physical = options.physical;
    this.presence = new PersonPresence({
      clock: options.clock,
      ...(options.timing ? { timing: options.timing } : {}),
      changed: (surface) => {
        const app = appOf(surface);
        if (app) this.tell(app);
      },
      // Physical input counts for an app only while it is frontmost: the keys went to it.
      ...(physical
        ? {
            sample: async (surface: string) => {
              const at = await physical.lastInputAt();
              if (
                at === undefined ||
                this.clock.now() - at >= (options.timing?.quietMs ?? personQuietMs)
              )
                return undefined;
              return (await physical.frontmost()) === appOf(surface) ? at : undefined;
            },
          }
        : {}),
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

  /** The agent acted in `app`; with a point, viewers draw its cursor there. */
  acted(app: string, point: { x: number; y: number } | undefined, kind: AgentPointerKind): void {
    if (!point) return;
    this.pointers.set(app, {
      x: Math.round(point.x),
      y: Math.round(point.y),
      kind,
      at: Math.max(0, Math.round(this.clock.now())),
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
