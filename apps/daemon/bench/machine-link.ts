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
import { startBenchDaemon } from "./slow-link-host.ts";
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
const entry = join(import.meta.dirname, "machine-link-daemon.ts");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0) : null;
};

async function measure(profileName: string) {
  const profile = linkProfile(profileName);
  const target = await startBenchDaemon(entry, (ready) => Ready.parse(ready), {
    MACHINE_LINK_ROLE: "target",
  });
  const source = await startBenchDaemon(entry, (ready) => SourceReady.parse(ready), {
    MACHINE_LINK_ROLE: "source",
    ACE_LISTEN: "local",
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
    await target.request({ op: "finish", thread: threadId });
    // The source hears the child finished on a later poll.
    const settleFrom = performance.now();
    let seen = "";
    for (let tries = 0; tries < 600; tries++) {
      seen = State.parse(await target.request({ op: "state", thread: threadId })).state;
      const calls = Calls.parse(await source.request({ op: "calls" }));
      const heard = calls.calls.some((entry) => entry.op === "status" && entry.at > settleFrom);
      if (seen === "done" && heard) break;
      await sleep(250);
    }
    const settledMs = Math.round(performance.now() - settleFrom);
    const settled = await window();
    return { profile: profile.name, childState: seen, delegate, settledMs, running, settled };
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

const startedAt = new Date().toISOString();
const loadBefore = loadavg();
const runs = [];
for (const profile of profiles) {
  process.stderr.write(`machine-link: ${profile.name}\n`);
  const run = await measure(profile.name);
  runs.push(run);
  process.stderr.write(`${JSON.stringify(run)}\n`);
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
