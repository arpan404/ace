import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { criticalServices, type Criticality } from "./services/service-criticality.ts";

/**
 * Which services' starts are running right now, kept on disk as they change. A daemon that
 * dies or is killed partway through a start leaves the names behind, so the next run can tell
 * which service it was stuck in. Safe mode leaves those off (ADR 0175).
 */
export interface AttemptFile {
  read(): string | undefined;
  write(text: string): void;
}

const Stored = z.object({ running: z.array(z.string().max(200)).max(200) });

export interface StartupAttempts {
  /** Services the last run was still starting when it stopped. */
  previous: readonly string[];
  onAttempt(name: string, running: boolean): void;
}

export function startupAttempts(file: AttemptFile): StartupAttempts {
  let previous: readonly string[] = [];
  try {
    const text = file.read();
    const parsed = text === undefined ? undefined : Stored.safeParse(JSON.parse(text));
    if (parsed?.success) previous = parsed.data.running;
  } catch {
    // Damaged or unreadable: nothing is known about the last run.
  }
  const running = new Set<string>();
  return {
    previous,
    onAttempt(name, isRunning) {
      if (running.has(name) === isRunning) return;
      if (isRunning) running.add(name);
      else running.delete(name);
      try {
        file.write(JSON.stringify({ running: [...running] }));
      } catch {
        // A full or read-only disk only costs safe mode its precision.
      }
    },
  };
}

/**
 * What safe mode leaves off: services the last run never finished starting, and services that
 * crashed the daemon twice in a short window (`crashed`), except those the daemon cannot run
 * without (an essential service and everything it requires).
 */
export function safeModeSkips(
  previous: readonly string[],
  order: readonly Criticality[],
  crashed: readonly string[] = [],
): string[] {
  const left = new Set([...previous, ...crashed]);
  const critical = criticalServices(order);
  return order
    .filter((entry) => left.has(entry.name) && !critical.has(entry.name))
    .map(({ name }) => name);
}

/** The record as a file: replaced whole, so a crash mid-write leaves the previous one. */
export function attemptFile(path: string): AttemptFile {
  return {
    read() {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    write(text) {
      writeFileSync(`${path}.pending`, text, { mode: 0o600 });
      renameSync(`${path}.pending`, path);
    },
  };
}
