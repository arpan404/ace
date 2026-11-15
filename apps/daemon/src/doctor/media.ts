import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckResult } from "@ace/diagnostics";
import { MediaCapability } from "@ace/protocol";
import { z } from "zod";
import { findMediaBinary } from "../services/media.ts";
import type { DoctorFeature } from "./feature.ts";
import { clip, milliseconds } from "./format.ts";

type Verdict = Omit<CheckResult, "id">;

/**
 * `ace doctor`'s ace-media checks (ADR 0148): the start probe's whole table, timed-out and
 * failed trials included, and the encoder ranking's kept results. It runs `ace-media --probe`
 * itself, so it works whether or not the daemon is up. Read-only.
 */

/** What the checks read, so tests can stand in for the binary. */
export type MediaPorts = {
  binary(): string | undefined;
  /** `ace-media --probe --data-dir <dir>`'s output. */
  probe(binary: string, dataDir: string, signal: AbortSignal): Promise<string>;
};

export const systemMediaPorts: MediaPorts = {
  binary: findMediaBinary,
  probe: async (binary, dataDir, signal) =>
    (
      await promisify(execFile)(binary, ["--probe", "--data-dir", dataDir], {
        timeout: probeTimeoutMs,
        signal,
      })
    ).stdout,
};

/** The probe's own bound is 3 s; the rest is the process starting. */
const probeTimeoutMs = 10_000;
/** `ready` waits at most this long for the probe. */
const readyBudgetMs = 3_000;
const hardwareBackends = new Set(["vt", "mf", "vaapi", "nv"]);
const nothing = "Nothing to do.";
const driverFix =
  "A trial that failed or timed out falls back to the processor. Update the graphics driver, restart the computer, then run ace doctor again.";
const installFix = "Run ace update apply, or restart the ace app, to install ace-media again.";

const RankEntry = z.looseObject({
  vendor: z.number(),
  device: z.number(),
  driver: z.string(),
  codec: z.string(),
  size: z.string(),
  winner: z.string(),
});
/** Decoded leniently: an entry a newer ace-media writes differently is counted, not fatal. */
const ProbeReport = z.looseObject({
  probeMs: z.number().nonnegative(),
  capabilities: z.array(z.unknown()),
  ranking: z.array(z.unknown()).catch([]),
});

export type MediaProbe = {
  probeMs: number;
  capabilities: MediaCapability[];
  ranking: z.infer<typeof RankEntry>[];
  /** Entries this doctor couldn't read. */
  unreadable: number;
};

export function parseMediaProbe(text: string): MediaProbe | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const report = ProbeReport.safeParse(json);
  if (!report.success) return undefined;
  let unreadable = 0;
  const read = <T>(schema: z.ZodType<T>, entries: unknown[]): T[] =>
    entries.flatMap((entry) => {
      const parsed = schema.safeParse(entry);
      if (parsed.success) return [parsed.data];
      unreadable++;
      return [];
    });
  return {
    probeMs: report.data.probeMs,
    capabilities: read(MediaCapability, report.data.capabilities),
    ranking: read(RankEntry, report.data.ranking),
    unreadable,
  };
}

function line(entry: MediaCapability): string {
  const what = [entry.step, entry.codec].filter(Boolean).join(" ");
  const where = entry.hardware ? "hardware" : "processor";
  const size = entry.state === "ok" ? `, up to ${entry.maxWidth}×${entry.maxHeight}` : "";
  return `${what} on ${entry.backend}: ${where}, ${entry.state}${size}`;
}

/** The capability table, and whether anything in it fell back. */
export function capabilitiesVerdict(probe: MediaProbe): Verdict {
  const encodes = probe.capabilities.some(
    (c) => c.step === "encode" && c.state === "ok" && c.hardware && hardwareBackends.has(c.backend),
  );
  const fellBack = probe.capabilities.filter(
    (c) => hardwareBackends.has(c.backend) && c.state !== "ok",
  );
  const slow = probe.probeMs > readyBudgetMs;
  const headline = encodes
    ? "Video encodes on hardware here."
    : "Video runs on the processor here: this computer has no hardware video encoder.";
  const notes = [
    ...(fellBack.length
      ? [`${fellBack.length} hardware trial(s) failed or timed out: those steps use the processor.`]
      : []),
    ...(slow ? [`The probe took longer than its ${milliseconds(readyBudgetMs)}.`] : []),
    ...(probe.unreadable ? [`${probe.unreadable} entr(ies) this ace couldn't read.`] : []),
  ];
  const message = [
    `${headline} The probe took ${milliseconds(probe.probeMs)}.`,
    ...notes,
    ...probe.capabilities.map(line),
  ].join("\n");
  const warn = fellBack.length > 0 || slow;
  return { status: warn ? "warn" : "ok", message: clip(message), fix: warn ? driverFix : nothing };
}

/** The ranking cache: which encoder won per GPU, driver and settings. */
export function rankingVerdict(probe: MediaProbe): Verdict {
  if (!probe.ranking.length)
    return {
      status: "ok",
      message:
        "No encoder ranking kept: where two hardware encoders serve one GPU, the first choice applies until one runs.",
      fix: nothing,
    };
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  const lines = probe.ranking.map(
    (r) =>
      `${hex(r.vendor)}:${hex(r.device)} driver ${r.driver}, ${r.codec} ${r.size}: ${r.winner}`,
  );
  return { status: "ok", message: clip(["Encoder ranking:", ...lines].join("\n")), fix: nothing };
}

export function mediaFeature(ports: MediaPorts): DoctorFeature {
  return {
    id: "media",
    checks(context) {
      let probed: Promise<MediaProbe | Verdict> | undefined;
      const probe = (signal: AbortSignal) =>
        (probed ??= (async (): Promise<MediaProbe | Verdict> => {
          const binary = ports.binary();
          if (!binary)
            return {
              status: "ok",
              message: "ace-media isn't installed here: live video takes ace's own path.",
              fix: nothing,
            };
          try {
            const report = parseMediaProbe(
              await ports.probe(binary, context.config.dataDir, signal),
            );
            return (
              report ?? {
                status: "warn",
                message: "ace-media's probe said nothing readable.",
                fix: installFix,
              }
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
              status: "warn",
              message: `ace-media's probe failed: ${reason}`,
              fix: installFix,
            };
          }
        })());
      const check = (id: string, verdict: (probe: MediaProbe) => Verdict) => ({
        id,
        fix: driverFix,
        timeoutMs: probeTimeoutMs + 2_000,
        async run(signal: AbortSignal): Promise<Verdict> {
          const found = await probe(signal);
          return "probeMs" in found ? verdict(found) : found;
        },
      });
      return [
        check("media.capabilities", capabilitiesVerdict),
        check("media.ranking", rankingVerdict),
      ];
    },
  };
}

export const media = mediaFeature(systemMediaPorts);
