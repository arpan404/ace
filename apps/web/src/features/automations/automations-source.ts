// TODO(client-gaps): feat/client-protocol-gaps routes ADR 0015's automation.put / remove / run /
// list / inbox through the daemon wire; on main they are schema-only. Fake mode (dev:fake and
// tests) serves them from memory with the approved design's content; a real daemon gets an
// empty list and writes that report the service unavailable. Components depend only on
// `AutomationsSource`; wiring the daemon replaces `useAutomationsSource` here and nothing else.
import type { Client } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { UnavailableError } from "@/boot/fake-backend.ts";
import { Automation, type AutomationRun } from "@ace/protocol";
import { seedAutomations, seedRuns } from "./automations-seed.ts";
import { localTimeZone, scheduleToPreset, weekdays, type SchedulePreset } from "./schedule.ts";

export interface AutomationEntry {
  automation: Automation;
  /** Next scheduled start; undefined when paused or not on a schedule. */
  nextRunAt: number | undefined;
}
export interface AutomationsSource {
  list(): Promise<AutomationEntry[]>;
  /** Recent runs across every automation, newest first. */
  inbox(limit: number): Promise<AutomationRun[]>;
  /** Create or replace. Rejects definitions the protocol schema refuses. */
  put(automation: Automation): Promise<void>;
  remove(id: string): Promise<void>;
  /** Start a run now, whatever the trigger. Resolves with the run as admitted. */
  run(id: string): Promise<AutomationRun>;
  /** Fires after any committed change, as the daemon publishes run updates. */
  onChange(listener: () => void): () => void;
}

export interface SourceDeps {
  now(): number;
  id(): string;
  timer: { set(delayMs: number, callback: () => void): () => void };
  /** How long a manual run takes in the fake. */
  runMs: number;
}

const outcomes: Record<string, string> = {
  "auto-dependency-audit": "No new advisories",
  "auto-pr-review": "No open pull requests to review",
  "auto-flaky-triage": "Nothing flaky across 3 runs",
  "auto-changelog": "Draft posted to #releases",
};

export function memoryAutomationsSource(
  deps: SourceDeps,
  seed: { automations: Automation[]; runs: AutomationRun[] },
): AutomationsSource {
  const automations = new Map(seed.automations.map((a) => [a.id, a]));
  let runs = seed.runs;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const settle = (runId: string, automationId: string) => {
    runs = runs.map((run) =>
      run.id === runId
        ? {
            ...run,
            status: "succeeded",
            finishedAt: deps.now(),
            result: outcomes[automationId] ?? "Finished with nothing to change",
          }
        : run,
    );
    changed();
  };
  return {
    async list() {
      const now = deps.now();
      return [...automations.values()].map((automation) => ({
        automation,
        nextRunAt: nextRun(automation, now),
      }));
    },
    async inbox(limit) {
      return runs.toSorted((a, b) => b.startedAt - a.startedAt).slice(0, limit);
    },
    async put(automation) {
      const parsed = Automation.parse(automation);
      automations.set(parsed.id, parsed);
      changed();
    },
    async remove(id) {
      if (!automations.delete(id)) throw new Error("not_found");
      changed();
    },
    async run(id) {
      const automation = automations.get(id);
      if (!automation) throw new Error("not_found");
      const startedAt = deps.now();
      const run: AutomationRun = {
        id: `run-${deps.id()}`,
        automationId: id,
        title: automation.title,
        eventKey: `manual:${startedAt}`,
        trigger: "manual",
        status: "running",
        startedAt,
      };
      runs = [run, ...runs];
      changed();
      deps.timer.set(deps.runMs, () => settle(run.id, id));
      return run;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Fake scheduler for the presets the form produces; the daemon owns real recurrence. */
function nextRun(automation: Automation, now: number): number | undefined {
  if (!automation.enabled || automation.trigger.kind !== "schedule") return undefined;
  const preset: SchedulePreset = scheduleToPreset(automation.trigger.schedule);
  if (preset.kind === "custom") {
    const daily = /^(\d+) (\d+) \* \* (\*|\d)$/.exec(preset.expression);
    if (!daily) return undefined;
    const day = daily[3] === "*" ? undefined : weekdays[(Number(daily[3]) + 6) % 7];
    return nextAt(now, `${daily[2]}:${daily[1]}`, day ? [day] : undefined);
  }
  switch (preset.kind) {
    case "hourly": {
      const top = new Date(now);
      top.setMinutes(0, 0, 0);
      return top.getTime() + preset.every * 3_600_000;
    }
    case "daily":
      return nextAt(now, preset.time, undefined);
    case "weekdays":
      return nextAt(now, preset.time, ["MO", "TU", "WE", "TH", "FR"]);
    case "weekly":
      return nextAt(now, preset.time, [preset.day]);
  }
}
function nextAt(now: number, time: string, days: readonly string[] | undefined): number {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  for (let i = 0; i < 8; i++) {
    const weekday = weekdays[(candidate.getDay() + 6) % 7];
    if (candidate.getTime() > now && (!days || (weekday && days.includes(weekday))))
      return candidate.getTime();
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

const timer = {
  set(delayMs: number, callback: () => void) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

// One source per daemon client, so each connection (and each test) starts from the seed.
const sources = new WeakMap<Client, AutomationsSource>();

export function useAutomationsSource(): AutomationsSource {
  const client = useClient();
  const fake = useDaemonConnection().mode === "fake";
  let source = sources.get(client);
  if (!source) {
    source = fake ? fakeAutomationsSource() : unavailableAutomationsSource();
    sources.set(client, source);
  }
  return source;
}

/** A real daemon on main: nothing listed, and every write says the service isn't there. */
function unavailableAutomationsSource(): AutomationsSource {
  const no = () => Promise.reject(new UnavailableError("Automations"));
  return {
    list: async () => [],
    inbox: async () => [],
    put: no,
    remove: no,
    run: no,
    onChange: () => () => {},
  };
}

/** The in-memory stand-in, seeded with the design's automations and runs at the wall clock. */
function fakeAutomationsSource(): AutomationsSource {
  const now = Date.now();
  return memoryAutomationsSource(
    { now: () => Date.now(), id: () => crypto.randomUUID(), timer, runMs: 1_500 },
    {
      automations: seedAutomations(Math.floor(now / 60_000) * 60_000, localTimeZone()),
      runs: seedRuns(now),
    },
  );
}
