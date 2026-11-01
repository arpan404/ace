/**
 * Attributes a `.cpuprofile` of the minified daemon bundle to causes, through the bundle's
 * source maps. Prints JSON: self time by category, inclusive time by subsystem, and the top
 * source files and functions.
 *
 * node tools/daemon-bench/src/profile/attribute.ts PROFILE --maps=BUNDLE_DIR [--events=N]
 *   [--from-ms=N --to-ms=N]  (slice relative to the profile start)
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { option } from "./args.ts";
import { categorize, subsystem } from "./categories.ts";
import { MappedFile } from "./source-map.ts";

const CallFrame = z.object({
  functionName: z.string(),
  url: z.string(),
  lineNumber: z.number(),
  columnNumber: z.number(),
});
const Profile = z.object({
  nodes: z.array(
    z.object({ id: z.number(), callFrame: CallFrame, children: z.array(z.number()).optional() }),
  ),
  startTime: z.number(),
  endTime: z.number(),
  samples: z.array(z.number()),
  timeDeltas: z.array(z.number()),
});

export interface Frame {
  /** Repository- or package-relative source path, or a Node/V8 pseudo path. */
  source: string;
  name: string;
}

/** Shortens a source-map path to `apps/…`, `packages/…` or `node_modules:<package>/…`. */
function normalize(source: string): string {
  const modules = source.lastIndexOf("node_modules/");
  if (modules >= 0) return `node_modules:${source.slice(modules + 13)}`;
  const match = /(?:^|\/)((?:apps|packages|tools)\/.*)$/.exec(source);
  return match?.[1] ?? source;
}

function add(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) ?? 0) + value);
}

export function attribute(path: string, mapsDir: string, fromMs?: number, toMs?: number) {
  const profile = Profile.parse(JSON.parse(readFileSync(path, "utf8")));
  const maps = new Map<string, MappedFile | undefined>();
  const mapFor = (url: string) => {
    const file = basename(url);
    if (!maps.has(file)) {
      const candidate = join(mapsDir, `${file}.map`);
      maps.set(file, existsSync(candidate) ? new MappedFile(candidate) : undefined);
    }
    return maps.get(file);
  };
  const parent = new Map<number, number>();
  const frames = new Map<number, Frame>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
    const { url, functionName, lineNumber, columnNumber } = node.callFrame;
    let frame: Frame;
    if (!url) frame = { source: `(native)`, name: functionName || "(anonymous)" };
    else if (url.startsWith("node:")) frame = { source: url, name: functionName };
    else {
      const original = mapFor(url)?.lookup(lineNumber, columnNumber);
      frame = original
        ? { source: normalize(original.source), name: original.name ?? functionName }
        : { source: basename(url), name: functionName };
    }
    frames.set(node.id, frame);
  }
  const self = new Map<string, number>();
  const files = new Map<string, number>();
  const functions = new Map<string, number>();
  const inclusive = new Map<string, number>();
  const nativeCallers = new Map<string, number>();
  let time = 0;
  let total = 0;
  let idle = 0;
  for (let index = 0; index < profile.samples.length; index++) {
    // V8 records the delta before each sample; the sample's own duration is the next delta.
    const dt = profile.timeDeltas[index + 1] ?? 0;
    time += profile.timeDeltas[index] ?? 0;
    const at = time / 1000;
    if (fromMs !== undefined && at < fromMs) continue;
    if (toMs !== undefined && at > toMs) continue;
    const id = profile.samples[index] ?? 0;
    const frame = frames.get(id);
    if (!frame) continue;
    if (frame.name === "(idle)") {
      idle += dt;
      continue;
    }
    total += dt;
    const stack: Frame[] = [];
    for (let node: number | undefined = id; node !== undefined; node = parent.get(node)) {
      const entry = frames.get(node);
      if (entry) stack.push(entry);
    }
    add(self, categorize(stack), dt);
    if (frame.source === "(native)" && !frame.name.startsWith("(")) {
      const callers = stack.filter((entry) => entry.source !== "(native)").slice(0, 2);
      add(
        nativeCallers,
        `${frame.name} <- ${callers.map((entry) => `${entry.name} ${entry.source}`).join(" <- ")}`,
        dt,
      );
    }
    add(files, frame.source, dt);
    add(functions, `${frame.name} ${frame.source}`, dt);
    const seen = new Set<string>();
    for (const entry of stack) {
      const owner = subsystem(entry);
      if (owner && !seen.has(owner)) {
        seen.add(owner);
        add(inclusive, owner, dt);
      }
    }
  }
  const table = (map: Map<string, number>, limit = Infinity) =>
    [...map]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, us]) => ({
        key,
        ms: Math.round(us / 100) / 10,
        percent: Math.round((us / total) * 1000) / 10,
      }));
  return {
    busyMs: Math.round(total / 1000),
    idleMs: Math.round(idle / 1000),
    wallMs: Math.round((profile.endTime - profile.startTime) / 1000),
    categories: table(self),
    inclusive: table(inclusive),
    files: table(files, 45),
    functions: table(functions, 60),
    nativeCallers: table(nativeCallers, 40),
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Pass a .cpuprofile");
  const from = option("from-ms");
  const to = option("to-ms");
  const result = attribute(
    path,
    option("maps") ?? "/tmp/ace-rust-case/bundle",
    from === undefined ? undefined : Number(from),
    to === undefined ? undefined : Number(to),
  );
  const events = Number(option("events") ?? 0);
  process.stdout.write(
    `${JSON.stringify(
      events
        ? {
            ...result,
            perEventMs: Object.fromEntries(
              result.categories.map((row) => [
                row.key,
                Math.round((row.ms / events) * 1000) / 1000,
              ]),
            ),
          }
        : result,
      null,
      2,
    )}\n`,
  );
}
