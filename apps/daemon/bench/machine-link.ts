/**
 * Daemon-to-daemon calls over a slow link: two real daemons from this checkout in temporary
 * homes (machine-link-daemon.ts), the source paired with the target the way `ace remote add`
 * saves a machine, but with the saved origin pointing at a link shaper in front of the target's
 * TLS listener. The source's agent delegates one task there; the remote child runs under a
 * scripted provider. For each profile it reports, per `status` call, time, round trips and
 * bytes, and the calls per minute the source makes while the child works and after it settles.
 *
 *   bun apps/daemon/bench/machine-link.ts [--profiles=3g-slow,3g-fast,lan] [--seconds=60]
 *     [--output=FILE.json]
 *
 * Report only, never a gate. See slow-link-REPORT.md.
 */
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { accessRequest, redeemPairing } from "@ace/daemon/client-access";
import { PairingResponse } from "@ace/protocol";
import { countsSince, linkProfile, startLinkShaper, type LinkCounts } from "@ace/perf-kit/link";
import { startBenchDaemon } from "@ace/perf-kit/daemon";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { writeMeasurement } from "./output.ts";

const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const profiles = argument("profiles", "3g-slow,3g-fast,lan").split(",").map(linkProfile);
const seconds = z.coerce.number().positive().parse(argument("seconds", "60"));
const output = argument("output", "");

const Ready = z.object({
  endpoint: z.string(),
  token: z.string(),
  remoteUrl: z.string(),
  fingerprint: z.string(),
});
/** The source listens only locally: it calls out, nobody pairs with it. */
const SourceReady = z.object({ endpoint: z.string(), token: z.string() });
const Calls = z.object({
  now: z.number(),
  calls: z.array(z.object({ op: z.string(), at: z.number(), ms: z.number(), ok: z.boolean() })),
});
const Delegated = z.object({ result: z.object({ data: z.object({ threadId: z.string() }) }) });
const State = z.object({ state: z.string() });
const daemonEntry = join(import.meta.dirname, "machine-link-daemon.ts");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0) : null;
};

async function measure(profileName: string) {
  const profile = linkProfile(profileName);
  const execPath = bunBinary();
  const target = await startBenchDaemon({
    entry: daemonEntry,
    execPath,
    parse: (ready) => Ready.parse(ready),
    env: { MACHINE_LINK_ROLE: "target" },
  });
  const source = await startBenchDaemon({
    entry: daemonEntry,
    execPath,
    parse: (ready) => SourceReady.parse(ready),
    env: { MACHINE_LINK_ROLE: "source", ACE_LISTEN: "local" },
  });
  const upstream = new URL(target.ready.remoteUrl);
  const shaper = await startLinkShaper({
    target: { host: upstream.hostname, port: Number(upstream.port) },
    profile,
  });
  try {
    const pairing = PairingResponse.parse(
      await accessRequest(target.ready.endpoint.replace("ws:", "http:"), "/v1/pairings", {
        method: "POST",
        token: target.ready.token,
        body: { scopes: ["read", "operate"] },
      }),
    );
    const credential = await redeemPairing(pairing.url, "MacBook");
    await source.request({
      op: "pair",
      origin: `https://${shaper.address}/`,
      fingerprint: target.ready.fingerprint,
      deviceId: credential.device.id,
      token: credential.token,
    });
    const delegateFrom = { at: performance.now(), counts: shaper.counts() };
    const { threadId } = Delegated.parse(await source.request({ op: "delegate" })).result.data;
    const delegate = {
      ms: Math.round(performance.now() - delegateFrom.at),
      ...link(countsSince(delegateFrom.counts, shaper.counts())),
    };

    /** The source's calls and the link's counts over one window of `seconds`. */
    const window = async () => {
      const before = Calls.parse(await source.request({ op: "calls" }));
      const counts = shaper.counts();
      await sleep(seconds * 1000);
      const after = Calls.parse(await source.request({ op: "calls" }));
      const delta = countsSince(counts, shaper.counts());
      const made = after.calls.filter((entry) => entry.at >= before.now);
      const elapsedMinutes = (after.now - before.now) / 60_000;
      const ops: Record<string, number> = {};
      for (const entry of made) ops[entry.op] = (ops[entry.op] ?? 0) + 1;
      const status = made.filter((entry) => entry.op === "status");
      return {
        seconds: Math.round((after.now - before.now) / 1000),
        callsPerMinute: Number((made.length / elapsedMinutes).toFixed(1)),
        statusPerMinute: Number((status.length / elapsedMinutes).toFixed(1)),
        ops,
        failed: made.filter((entry) => !entry.ok).length,
        /** Per call, over every call in the window (status calls dominate). */
        perCall: made.length
          ? {
              medianMs: median(made.map((entry) => entry.ms)),
              statusMedianMs: median(status.map((entry) => entry.ms)),
              roundTrips: Number(((delta.connections + delta.upFlights) / made.length).toFixed(1)),
              downBytes: Math.round(delta.downBytes / made.length),
              upBytes: Math.round(delta.upBytes / made.length),
            }
          : null,
        link: link(delta),
      };
    };
    const running = await window();
    // Times below are the source's own clock: performance.now() differs between processes.
    const finishedAt = Calls.parse(await source.request({ op: "calls" })).now;
    await target.request({ op: "finish", thread: threadId });
    let seen = "";
    let firstStatusAfterFinishMs: number | null = null;
    for (let tries = 0; tries < 600 && firstStatusAfterFinishMs === null; tries++) {
      seen = State.parse(await target.request({ op: "state", thread: threadId })).state;
      const next = Calls.parse(await source.request({ op: "calls" })).calls.find(
        (entry) => entry.op === "status" && entry.at > finishedAt,
      );
      if (seen === "done" && next)
        firstStatusAfterFinishMs = Math.round(next.at + next.ms - finishedAt);
      else await sleep(250);
    }
    const settled = await window();
    return {
      profile: profile.name,
      childState: seen,
      delegate,
      /** From the child finishing to the source's first status answer after it. */
      firstStatusAfterFinishMs,
      running,
      settled,
    };
  } finally {
    await shaper.close();
    await source.close();
    await target.close();
  }
}

function link(counts: LinkCounts) {
  return {
    connections: counts.connections,
    roundTrips: counts.connections + counts.upFlights,
    downBytes: counts.downBytes,
    upBytes: counts.upBytes,
    stalls: counts.stalls,
  };
}

type Run = Awaited<ReturnType<typeof measure>>;
const perCall = (call: Run["running"]["perCall"]) =>
  call
    ? `${call.medianMs} ms ${call.roundTrips} RT ${(call.downBytes / 1024).toFixed(1)} KiB down ` +
      `${(call.upBytes / 1024).toFixed(1)} KiB up`
    : "none";
const phase = (label: string, value: Run["running"]) =>
  `  ${label.padEnd(16)} ${String(value.statusPerMinute).padStart(5)} status/min ` +
  `${String(value.callsPerMinute).padStart(5)} calls/min, per call ${perCall(value.perCall)}`;

function summary(run: Run): string {
  return [
    `${run.profile}: delegate ${run.delegate.ms} ms ${run.delegate.roundTrips} RT, ` +
      `first status after the child finished ${run.firstStatusAfterFinishMs ?? "never"} ms`,
    phase("child running", run.running),
    phase("child settled", run.settled),
  ].join("\n");
}

const startedAt = new Date().toISOString();
const loadBefore = loadavg();
const runs = [];
for (const profile of profiles) {
  process.stderr.write(`machine-link: ${profile.name}\n`);
  const run = await measure(profile.name);
  runs.push(run);
  process.stderr.write(`${summary(run)}\n`);
}
const result = {
  bench: "machine-link",
  startedAt,
  machine: { cpus: cpus().length, loadBefore, loadAfter: loadavg() },
  seconds,
  runs,
};
if (output) await writeMeasurement(output, JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result)}\n`);
