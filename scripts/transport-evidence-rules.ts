// SPDX-License-Identifier: Apache-2.0
/**
 * T1b.5's per-case evidence rules: which server tests must show what the Rust remote listener did
 * in their own case window (`t1b-brief.md`'s "The proof run, Autobahn and the bench"), the
 * lifecycle table, and the cases exempt because they are pure TypeScript with no listener of their
 * own. A key is the test file's name without `.test.ts` (`remote-direct.process`); a title is the
 * test's own name, as the evidence marker carries it.
 *
 * Every exemption names the reason the case cannot show remote traffic; the reviewer confirms each.
 */
import type { EvidenceLine, ListenerInstance, Owned, WindowView } from "./transport-evidence.ts";

export { EXEMPT_CASES, type ExemptCase } from "./transport-evidence-exemptions.ts";

/** A key of a file whose every case needs remote traffic inside its own markers. */
export const TRAFFIC_FILES: readonly string[] = [
  "remote.server",
  "remote-boundaries.server",
  "remote-runtime.server",
  "remote-compression.server",
  "tailscale-https.server",
  "remote-payloads.process",
  "access-cors.server",
  "ticket-allocation.server",
  "sni-listener.process",
  "sni-keep-alive.process",
  "sni-keep-alive-on-node.process",
  "native-remote.process",
  // Windows only: counted on the VM run.
  "remote-restart.server",
];

/** A counter one case must show, on top of the traffic rule (`t1b-brief.md`). */
export interface CaseCounter {
  file: string;
  title: string;
  /** The `handled`/`close` counter that must be over zero in the case's window. */
  counter: "deflatedOut" | "inflatedIn" | "trustedHandshakes" | "postQuantumHandshakes";
}

/** The cases with a counter of their own. */
export const CASE_COUNTERS: readonly CaseCounter[] = [
  {
    file: "remote-compression.server",
    title: "delivers a large thread to a remote device intact in far fewer bytes",
    counter: "deflatedOut",
  },
  {
    file: "remote-compression.server",
    title: "closes a remote socket whose message inflates past the payload limit",
    counter: "inflatedIn",
  },
  {
    file: "remote.server",
    title: "consumes a socket ticket once and accepts it on a pinned WSS connection",
    counter: "postQuantumHandshakes",
  },
  {
    file: "tailscale-https.server",
    title:
      "over Tailscale, a pairing link names the ts.net host once browsers asking for it get Tailscale's certificate",
    counter: "trustedHandshakes",
  },
  {
    file: "tailscale-https.server",
    title:
      "a renewed Tailscale certificate is served to new connections without restarting the listener",
    counter: "trustedHandshakes",
  },
  {
    file: "tailscale-https.server",
    title:
      "the native listener serves the trusted ts.net certificate, and the pin for every other name",
    counter: "trustedHandshakes",
  },
];

/** One lifecycle case and the proof its window must hold. */
export interface LifecycleCase {
  file: string;
  title: string;
  /** What the case is, in one line, for the printed report. */
  proof: string;
  check(view: WindowView): string | undefined;
}

/** Whether a line belongs to this listener: instance ids repeat across processes, so both keys. */
function ofListener(line: EvidenceLine, listener: ListenerInstance): boolean {
  return line.pid === listener.pid && line.instance === listener.instance;
}

/** The lines one listener instance carries for one event inside the window. */
function eventLines(view: WindowView, listener: ListenerInstance, event: string): EvidenceLine[] {
  return view.lines.filter((line) => ofListener(line, listener) && line.event === event);
}

/** What a window owns of one instance, absent as zeros. */
function ownedOf(view: WindowView, listener: ListenerInstance): Owned | undefined {
  return view.owned.get(`${listener.pid}:${listener.instance}`);
}

/** The remote instances whose bind sits inside the window. */
function boundRemote(view: WindowView): ListenerInstance[] {
  return view.bound.filter((listener) => listener.listener === "remote");
}

/** T1b.5's lifecycle table: the proof is what the listener did, not traffic. */
export const LIFECYCLE_CASES: readonly LifecycleCase[] = [
  {
    file: "remote-direct.process",
    title: "a bind that finishes after remote access closed leaves nothing listening",
    proof:
      "a close-requested with bound: false on the port, the bind that lands after it, its close-requested with bound: true, then a close with no connections and no handled traffic",
    check(view) {
      const retire = view.lines.find(
        (line) =>
          line.listener === "remote" &&
          line.event === "close-requested" &&
          line.bound === false &&
          line.port !== undefined,
      );
      if (retire === undefined)
        return "no close-requested with bound: false: nothing says the retire preceded the bind";
      const port = retire.port;
      if (port === undefined) return "the close-requested names no port";
      // A request for port 0 has no port to name until it binds; the case's one bind is that one.
      const late = boundRemote(view).find(
        (listener) => listener.bindAt > (retire.at ?? -1) && (port === 0 || listener.port === port),
      );
      if (late === undefined) return `no bind on port ${port} after the retire`;
      const acknowledged = view.lines.find(
        (line) => ofListener(line, late) && line.event === "close-requested" && line.bound === true,
      );
      if (acknowledged === undefined)
        return `no close-requested with bound: true for the instance that bound on port ${port}`;
      const close = late.close;
      if (close === undefined) return `the instance that bound on port ${port} has no close`;
      if ((close.connections ?? 0) !== 0)
        return `the close on port ${port} counts connections, so the late listener served`;
      const served = view.lines.some(
        (line) =>
          ofListener(line, late) &&
          line.event === "handled" &&
          ((line.connections ?? 0) > 0 || (line.exchanges ?? 0) > 0 || (line.upgrades ?? 0) > 0),
      );
      if (served) return `a handled line on port ${port} counts traffic, so it served`;
      return undefined;
    },
  },
  {
    file: "remote-direct.process",
    title:
      "moving to Tailscale as remote access closes opens no listener and fetches no certificate",
    proof: "one bind (the LAN port), its own close, and no second bind",
    check(view) {
      const binds = boundRemote(view);
      if (binds.length !== 1)
        return `${binds.length} binds; the case opens exactly one (the LAN port)`;
      const only = binds[0];
      if (only === undefined) return "no bind line";
      if (eventLines(view, only, "close").length === 0)
        return `no close for the instance that bound on port ${only.port}`;
      return undefined;
    },
  },
  {
    file: "native-remote.process",
    title:
      "a LAN port taken at start is reported, and once freed the listener serves on the next retry",
    proof: "bind-failed EADDRINUSE, then a bind on the port and an HTTP exchange on that instance",
    check(view) {
      const failed = view.lines.find(
        (line) => line.event === "bind-failed" && line.listener === "remote",
      );
      if (failed === undefined) return "no bind-failed line";
      if (failed.code !== "EADDRINUSE")
        return `bind-failed carries ${String(failed.code)}, not EADDRINUSE`;
      const port = failed.port;
      if (port === undefined) return "the bind-failed line names no port";
      const bound = boundRemote(view).find(
        (listener) => listener.port === port && listener.bindAt > (failed.at ?? -1),
      );
      if (bound === undefined) return `no bind on port ${port} after the refused one`;
      const served = view.lines.some(
        (line) =>
          ofListener(line, bound) &&
          (line.at ?? -1) > bound.bindAt &&
          (line.event === "handled" || line.event === "close") &&
          (line.connections ?? 0) > 0 &&
          (line.exchanges ?? 0) > 0,
      );
      if (!served) return `no HTTP exchange on the instance that bound on port ${port}`;
      return undefined;
    },
  },
  {
    file: "sni-listener.process",
    title:
      "closing drops waiting and idle connections at once and leaves WebSockets to their server",
    proof: "a listener instance closed on the port, then a second instance bound on it (the reuse)",
    check(view) {
      const binds = boundRemote(view);
      for (const first of binds) {
        if (first.closeAt < 0) continue;
        const second = binds.find(
          (listener) =>
            !(listener.pid === first.pid && listener.instance === first.instance) &&
            listener.port === first.port &&
            listener.bindAt > first.closeAt,
        );
        if (second !== undefined) return undefined;
      }
      return "no listener instance closed on the port and then a second instance bound on it";
    },
  },
  {
    file: "sni-listener.process",
    title:
      "a client that stalls in the TLS handshake is disconnected, and the listener keeps serving",
    proof: "one listener instance with connections and exchanges: the second client was served",
    check(view) {
      for (const listener of boundRemote(view)) {
        const counts = ownedOf(view, listener);
        if (counts !== undefined && counts.connections > 0 && counts.exchanges > 0)
          return undefined;
      }
      return "no listener instance on which one client connected and another exchanged a request";
    },
  },
];

/**
 * Files T1b.5's rules name that T1a.8's discovery does not reach: it seeds on `startServer`,
 * `startDaemon` and `fixture`, while these start their listeners through `sni-test-support` and
 * `remoteDirect` directly. The proof run adds them, so every rule-named case is executed and
 * checked; `list-server-tests.ts` itself is unchanged.
 */
export const CASE_RULE_FILES: readonly string[] = [
  "apps/daemon/src/remote-direct.process.test.ts",
  "apps/daemon/src/sni-listener.process.test.ts",
  "apps/daemon/src/machines/sni-keep-alive.process.test.ts",
  // A Node-only suite (`scripts/test-tiers.ts`): the proof run gives it a Node leg, so the same
  // cases are checked against the native listener on the runtime release builds use.
  "apps/daemon/src/machines/sni-keep-alive-on-node.process.test.ts",
];
