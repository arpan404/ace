import { probeOutput } from "@ace/provider-kit/process";
import { z } from "zod";
import { readBoundedText } from "./bounded-file.ts";

import { PreviewPort } from "@ace/protocol/preview";
/** Listener tables are snapshots, not history. Malformed OS rows are ignored. */
export function parseListeningPorts(text: string, format: "lsof" | "proc"): Set<number> {
  if (text.length > 4_194_304) throw new Error("Listener table exceeds limit");
  const ports = new Set<number>();
  for (const line of text.split("\n")) {
    let candidate: number | undefined;
    if (format === "lsof") {
      const match = /^n.*:(\d+)(?:\s|$)/.exec(line);
      if (match?.[1]) candidate = Number(match[1]);
    } else {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === "0A") candidate = Number.parseInt(fields[1]?.split(":")[1] ?? "", 16);
    }
    if (candidate === undefined) continue;
    const result = PreviewPort.safeParse(candidate);
    if (result.success) ports.add(result.data);
  }
  return ports;
}
export async function discoverListeningPorts(
  platform: NodeJS.Platform = process.platform,
): Promise<Set<number>> {
  if (platform === "darwin") {
    const output = await probeOutput("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"], {
      maxBytes: 4_194_304,
      timeoutMs: 5000,
    });
    if (output.code !== 0 && output.code !== 1) throw new Error("lsof listener discovery failed");
    return parseListeningPorts(output.stdout, "lsof");
  }
  if (platform === "linux") {
    const tables = await Promise.all([
      readBoundedText("/proc/net/tcp"),
      readBoundedText("/proc/net/tcp6").catch((error: unknown) => {
        if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return "";
        throw error;
      }),
    ]);
    return parseListeningPorts(tables.join("\n"), "proc");
  }
  throw new Error(`Unsupported preview discovery platform: ${platform}`);
}
export type PortDiff = { added: number[]; removed: number[] };
export async function pollPorts(options: {
  scan: () => Promise<ReadonlySet<number>>;
  onChange: (diff: PortDiff) => void;
  onError: (error: unknown) => void;
  signal: AbortSignal;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  minDelay?: number;
  maxDelay?: number;
}): Promise<void> {
  const min = z
    .number()
    .int()
    .positive()
    .parse(options.minDelay ?? 1000);
  const max = z
    .number()
    .int()
    .min(min)
    .parse(options.maxDelay ?? 30_000);
  let delay = min;
  let previous: ReadonlySet<number> = new Set();
  while (!options.signal.aborted) {
    try {
      const current = new Set(await options.scan());
      if (options.signal.aborted) break;
      const added = [...current].filter((p) => !previous.has(p));
      const removed = [...previous].filter((p) => !current.has(p));
      if (added.length || removed.length) {
        options.onChange({ added, removed });
        delay = min;
      } else delay = Math.min(max, delay * 2);
      previous = current;
    } catch (error) {
      options.onError(error);
      delay = Math.min(max, delay * 2);
    }
    try {
      await options.wait(delay, options.signal);
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
}
