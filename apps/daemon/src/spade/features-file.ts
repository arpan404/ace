import { watch } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultFeatures,
  featuresFileName,
  readFeatures,
  withSpadeShown,
  type FeatureFlags,
  type FeaturesRead,
} from "./features.ts";

/** `features.json` in `home`, read leniently; a file that can't be read counts as missing. */
export async function loadFeatures(home: string): Promise<FeaturesRead> {
  return readFeatures(await readText(join(home, featuresFileName)));
}

/** Shows or hides Spade in `home`'s `features.json`, keeping its other keys. Atomic. */
export async function setSpadeShown(home: string, shown: boolean): Promise<void> {
  const path = join(home, featuresFileName);
  const next = withSpadeShown(readFeatures(await readText(path)), shown);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, next, { mode: 0o600 });
  await rename(temporary, path);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export interface FeaturesWatchRuntime {
  /** The file's text, or undefined when there is none. */
  readText(path: string): Promise<string | undefined>;
  /**
   * Calls `changed` on a change in `directory`, with the file's name when the OS gives one.
   * Undefined when the folder can't be watched; the watch then polls.
   */
  watch(directory: string, changed: (file: string | undefined) => void): (() => void) | undefined;
  /** Runs `run` every `ms`; returns the stop. */
  every(ms: number, run: () => void): () => void;
}

export const nodeFeaturesRuntime: FeaturesWatchRuntime = {
  readText,
  watch(directory, changed) {
    try {
      const watcher = watch(directory, { persistent: false }, (_event, file) =>
        changed(typeof file === "string" ? file : undefined),
      );
      watcher.on("error", () => {});
      return () => watcher.close();
    } catch {
      return undefined;
    }
  },
  every(ms, run) {
    const timer = setInterval(run, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};

/** How often the file is read again when its folder can't be watched. */
const pollMs = 5_000;

export interface FeaturesWatch {
  current(): FeatureFlags;
  close(): void;
}

/**
 * `features.json` in `home`, read at start and again whenever it changes, so flipping a flag
 * takes effect without a restart. A file that can't be read leaves the defaults and logs one
 * warning per distinct problem; fixing the file recovers on its own. `onChange` hears only real
 * changes to the flags.
 */
export async function watchFeatures(input: {
  home: string;
  runtime?: FeaturesWatchRuntime;
  log(level: "info" | "warn", message: string): void;
  onChange(flags: FeatureFlags): void;
}): Promise<FeaturesWatch> {
  const runtime = input.runtime ?? nodeFeaturesRuntime;
  const path = join(input.home, featuresFileName);
  let problem: string | undefined;
  let closed = false;
  const read = async (): Promise<FeatureFlags> => {
    const result = readFeatures(await runtime.readText(path));
    if (result.problem !== problem) {
      if (result.problem) input.log("warn", result.problem);
      else if (problem) input.log("info", `${featuresFileName} reads fine again.`);
      problem = result.problem;
    }
    return result.flags;
  };
  let flags = defaultFeatures;
  // One read at a time; changes during a read are picked up by one more read after it.
  let reading: Promise<void> | undefined;
  let again = false;
  const reread = () => {
    if (closed) return;
    if (reading) {
      again = true;
      return;
    }
    reading = (async () => {
      do {
        again = false;
        const next = await read();
        if (closed) return;
        if (next.spade !== flags.spade) {
          flags = next;
          input.onChange(next);
        }
      } while (again);
    })().finally(() => {
      reading = undefined;
    });
  };
  const stop =
    runtime.watch(input.home, (file) => {
      if (file === undefined || file === featuresFileName) reread();
    }) ?? runtime.every(pollMs, reread);
  reread();
  await reading;
  return {
    current: () => flags,
    close() {
      closed = true;
      stop();
    },
  };
}
