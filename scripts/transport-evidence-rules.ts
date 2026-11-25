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
import type { EvidenceLine } from "./transport-evidence.ts";

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
];

/** One lifecycle case and the proof its window must hold. */
export interface LifecycleCase {
  file: string;
  title: string;
  /** What the case is, in one line, for the printed report. */
  proof: string;
  check(window: readonly EvidenceLine[]): string | undefined;
}

/** The lines of one listener and port, in order. */
function forPort(
  window: readonly EvidenceLine[],
  port: number,
  listener: "remote" | "loopback",
): EvidenceLine[] {
  return window.filter((line) => line.port === port && line.listener === listener);
}

/** The numbers a bind, close or handled line carries, absent as zero. */
const connections = (line: EvidenceLine): number => line.connections ?? 0;
const exchanges = (line: EvidenceLine): number => line.exchanges ?? 0;

/** Every `bind` port of the window, in first-seen order. */
function bindPorts(window: readonly EvidenceLine[], listener = "remote"): number[] {
  const ports: number[] = [];
  for (const line of window)
    if (line.event === "bind" && line.listener === listener && line.port !== undefined)
      if (!ports.includes(line.port)) ports.push(line.port);
  return ports;
}

/** A close line on `port` after `from`, as the remaining lifecycle table needs. */
function closeAfter(
  window: readonly EvidenceLine[],
  from: number,
  port: number,
  bound?: boolean,
): number {
  for (let index = from + 1; index < window.length; index++) {
    const line = window[index];
    if (line === undefined || line.listener !== "remote" || line.port !== port) continue;
    if (line.event !== "close-requested" && line.event !== "close") continue;
    if (bound !== undefined && line.bound !== bound) continue;
    return index;
  }
  return -1;
}

/** The index of the last line matching `match`, or -1. */
function lastIndex(
  window: readonly EvidenceLine[],
  match: (line: EvidenceLine) => boolean,
): number {
  for (let index = window.length - 1; index >= 0; index--) {
    const line = window[index];
    if (line !== undefined && match(line)) return index;
  }
  return -1;
}

/** T1b.5's lifecycle table: the proof is what the listener did, not traffic. */
export const LIFECYCLE_CASES: readonly LifecycleCase[] = [
  {
    file: "remote-direct.process",
    title: "a bind that finishes after remote access closed leaves nothing listening",
    proof:
      "a late bind, close-requested with bound: true, then a close with no connections: nothing listened",
    check(window) {
      const bound = lastIndex(window, (line) => line.event === "bind");
      if (bound < 0) return "no bind line";
      const port = window[bound]?.port;
      if (port === undefined) return "the bind line names no port";
      const requested = closeAfter(window, bound, port, true);
      if (requested < 0)
        return `no close-requested with bound: true after the bind on port ${port}`;
      const closed = window.findIndex(
        (line, index) =>
          index > requested &&
          line.listener === "remote" &&
          line.port === port &&
          line.event === "close",
      );
      if (closed < 0) return `no close on port ${port} after its close-requested`;
      if (connections(window[closed] ?? {}) !== 0)
        return `the close on port ${port} counts connections, so the late listener served`;
      return undefined;
    },
  },
  {
    file: "remote-direct.process",
    title:
      "moving to Tailscale as remote access closes opens no listener and fetches no certificate",
    proof: "one bind (the LAN port), its close, and no second bind",
    check(window) {
      const ports = bindPorts(window);
      if (ports.length !== 1)
        return `${ports.length} binds; the case opens exactly one (the LAN port)`;
      const port = ports[0] ?? 0;
      const bound = window.findIndex(
        (line) => line.event === "bind" && line.listener === "remote" && line.port === port,
      );
      if (bound < 0) return "no bind line";
      if (closeAfter(window, bound, port) < 0) return `no close on port ${port} after its bind`;
      return undefined;
    },
  },
  {
    file: "native-remote.process",
    title:
      "a LAN port taken at start is reported, and once freed the listener serves on the next retry",
    proof: "bind-failed EADDRINUSE, then a bind on the port, then a handled line with exchanges",
    check(window) {
      const failed = window.findIndex(
        (line) => line.event === "bind-failed" && line.listener === "remote",
      );
      if (failed < 0) return "no bind-failed line";
      const refused = window[failed];
      if (refused?.code !== "EADDRINUSE")
        return `bind-failed carries ${String(refused?.code)}, not EADDRINUSE`;
      const port = refused.port;
      if (port === undefined) return "the bind-failed line names no port";
      const bound = window.findIndex(
        (line, index) =>
          index > failed &&
          line.event === "bind" &&
          line.listener === "remote" &&
          line.port === port,
      );
      if (bound < 0) return `no bind on port ${port} after the refused one`;
      const served = window.findIndex(
        (line, index) =>
          index > bound &&
          line.listener === "remote" &&
          line.port === port &&
          (line.event === "handled" || line.event === "close") &&
          exchanges(line) > 0,
      );
      if (served < 0) return `no handled line with exchanges on port ${port} after its bind`;
      return undefined;
    },
  },
  {
    file: "sni-listener.process",
    title:
      "closing drops waiting and idle connections at once and leaves WebSockets to their server",
    proof: "close on the port, then a second bind on the same port (the port reuse)",
    check(window) {
      const ports = bindPorts(window);
      if (!ports.length) return "no bind line";
      const port = ports[0] ?? 0;
      const closed = window.findIndex(
        (line) => line.event === "close" && line.listener === "remote" && line.port === port,
      );
      if (closed < 0) return `no close on port ${port}`;
      const rebound = window.findIndex(
        (line, index) =>
          index > closed &&
          line.event === "bind" &&
          line.listener === "remote" &&
          line.port === port,
      );
      if (rebound < 0) return `no second bind on port ${port} after its close`;
      return undefined;
    },
  },
  {
    file: "sni-listener.process",
    title:
      "a client that stalls in the TLS handshake is disconnected, and the listener keeps serving",
    proof: "one listener with connections and exchanges: the second client was served",
    check(window) {
      for (const port of bindPorts(window)) {
        const lines = forPort(window, port, "remote");
        if (lines.some(connections) && lines.some(exchanges)) return undefined;
      }
      return "no listener on which one client connected and another exchanged a request";
    },
  },
];

/** One exempt case: pure TypeScript, or a listener the case never sends traffic to. */
export interface ExemptCase {
  file: string;
  title: string;
  reason: string;
}

/**
 * Cases no remote traffic can be required of, each with the reason a reviewer confirms. The first
 * is the one `t1b-brief.md` names; the rest are the same kind of case in the listed files.
 */
export const EXEMPT_CASES: readonly ExemptCase[] = [
  {
    file: "remote.server",
    title: "does not accept credentials in HTTP or socket URLs or unpinned remote requests",
    reason:
      "client-side refusals: the ticket and request helpers throw on a credential in the URL or a missing pin before any connection opens",
  },
  {
    file: "remote.server",
    title: "defaults to loopback only and requires explicit network exposure before pairing",
    reason:
      "the default is `local`: no remote listener is built, which is exactly what the case asserts",
  },
  {
    file: "tailscale-https.server",
    title: "a Tailscale certificate that expires while renewals fail stops being offered",
    reason: "the certificate service alone: no listener is built and no byte is served",
  },
  {
    file: "tailscale-https.server",
    title: "when the tailnet can't issue a certificate, pairing links keep the 100.x address",
    reason:
      "handshake identity only: the case reads the certificate a client is shown, and sends no request",
  },
  {
    file: "tailscale-https.server",
    title:
      "a certificate Linux refuses says how to fix it, and the next pairing link fetches it again",
    reason: "the fetch and the warning on the 100.x link: one handshake, no HTTP exchange",
  },
  {
    file: "tailscale-https.server",
    title: "the pin gives way only to a trusted certificate for the exact ts.net name asked for",
    reason:
      "client-side pin checks against the suite's own TLS servers (`serve`), not ace's listener",
  },
  {
    file: "remote-runtime.server",
    title: "an explicit launch override stays in force when saved settings change",
    reason: "run-time decisions only: the launch says `local`, so no remote listener opens",
  },
  {
    file: "remote-runtime.server",
    title: "paired operators cannot change global remote settings or machine identity",
    reason: "the operator's refusals arrive over the loopback socket; no remote listener opens",
  },
  {
    file: "remote-runtime.server",
    title:
      "an unavailable Tailscale network cannot change the saved transport or expose a LAN listener",
    reason: "the network is unavailable, so the case proves that no remote listener opens",
  },
  {
    file: "remote-runtime.server",
    title:
      "a pairing link is not issued for remote access that turned off while the link was being made",
    reason: "the link is withheld before any client connects; the case's work is TypeScript state",
  },
  {
    file: "remote-runtime.server",
    title:
      "remote access moves to this machine's new Tailscale address, and a failed check keeps it open",
    reason: "the move is proved by `remoteStarted`'s addresses and status; the clients are local",
  },
  {
    file: "remote-runtime.server",
    title:
      "saved unavailable remote access leaves local sessions usable and retries until the network returns",
    reason: "unavailable: no remote listener binds until the network returns after the case",
  },
  {
    file: "remote-runtime.server",
    title:
      "saved settings that can't be read keep remote access off and say so, and it comes up once they read again",
    reason: "remote access stays off while the store is unreadable, by design",
  },
  {
    file: "remote-runtime.server",
    title: "saved settings that couldn't be read come into force when they change",
    reason: "the same unreadable store, read again through TypeScript's settings path",
  },
  {
    file: "remote-runtime.server",
    title: "a write while saved settings can't be read is refused and leaves recovery running",
    reason: "a settings write's refusal: no listener is reached",
  },
  {
    file: "remote-runtime.server",
    title: "turning remote access off while the change can't be read turns it off once it reads",
    reason: "the switch's deferred turn-off, proved through settings and status",
  },
  {
    file: "remote-runtime.server",
    title: "a selected network reads waiting while its start is pending, then on",
    reason: "the network's reported state while its start is held; no client is served",
  },
  {
    file: "remote-runtime.server",
    title:
      "a signed-in daemon whose relay never answers its registration stops within its budget, and registers on the next start",
    reason: "the relay's registration budget: the direct listener is not what the case reads",
  },
  {
    file: "remote-runtime.server",
    title:
      "signing out while ace's relay is still registering leaves no registration once it lands",
    reason: "relay registration only; the LAN listener is not contacted",
  },
  {
    file: "remote-runtime.server",
    title: "saved remote access opens at startup without a launch override",
    reason:
      "the case reads the startup's own listeners and status; no client dials the remote listener, which only binds",
  },
  {
    file: "remote-runtime.server",
    title: "relay starts and stops on saved settings without replacing the host socket",
    reason:
      "relay settings and the host socket: the direct listener binds beside them and nothing dials it",
  },
  {
    file: "remote-runtime.server",
    title:
      "ace's relay waits for this machine to sign in, registers with a machine grant, and stops on sign-out",
    reason: "relay registration only; the direct listener binds but carries nothing",
  },
  {
    file: "remote-runtime.server",
    title:
      "turning the relay on with no address of its own saves, and puts a signed-in machine on ace's relay beside the LAN",
    reason: "settings and the relay's registration; the LAN listener binds and is not dialled",
  },
  {
    file: "remote-runtime.server",
    title: "LAN and Tailscale serve together, and Tailscale failing never closes the LAN",
    reason:
      "the case reads each listener's state through status; its clients use the loopback socket",
  },
  {
    file: "remote-runtime.server",
    title: "a LAN listener that can't open its port leaves the relay serving",
    reason:
      "the proof is the refused bind (`bind-failed`): a listener that never bound cannot carry an exchange",
  },
  {
    file: "remote-runtime.server",
    title:
      "a fresh home serves the LAN with nothing saved, and a taken port leaves the daemon running",
    reason:
      "bind and status only: the bound listener is read, the taken port is a `bind-failed`, and nothing dials either",
  },
  {
    file: "remote-runtime.server",
    title:
      "a signed-in daemon listens and pairs over the LAN while ace's relay never answers, and a stop then ends the wait at once",
    reason:
      "the pairing is issued and the daemon's state read; the LAN listener binds and is not dialled",
  },
  {
    file: "access-cors.server",
    title: "a web app on an allowed origin can list, pair and revoke devices with the daemon token",
    reason: "CORS is answered by the local HTTP server; the case never calls the remote one",
  },
  {
    file: "access-cors.server",
    title: "a foreign site gets a refused preflight and no CORS headers to read responses with",
    reason: "the same preflight and reads on the local HTTP server",
  },
  {
    file: "access-cors.server",
    title: "a request without an Origin, as the CLI sends, works and still needs the token",
    reason: "the CLI's local request and its refusal",
  },
  {
    file: "access-cors.server",
    title:
      "an allowed origin still needs credentials for status and tickets, and a code for redemption",
    reason: "status, tickets and redemption through the local HTTP server",
  },
  {
    file: "native-remote.process",
    title: "a Tailscale certificate that expires while renewals fail leaves Rust at its expiry",
    reason:
      "handshake identity only: the case reads the certificate each new connection is shown and sends no request",
  },
  {
    file: "native-remote.process",
    title: "a run-time listener that closed never binds",
    reason:
      "its proof is that no listener binds after the retire: a bind line would be the case's failure, and there is no traffic to count",
  },
  {
    file: "remote-compression.server",
    title: "keeps loopback sockets uncompressed",
    reason:
      "the loopback listener negotiates no extension by design: the case asserts a loopback socket carries none, and the remote one serves nothing",
  },
  {
    file: "access-cors.server",
    title: "the desktop renderer can redeem a link, request a ticket and read remote status",
    reason:
      "the renderer's redemption, ticket, socket and status all use the local HTTP server; the remote listener only binds",
  },
  {
    file: "access-cors.server",
    title:
      "the desktop app and the hosted web app, stable and beta, are allowed without configuration; other origins are not",
    reason: "the allowlist's answers on the local HTTP server",
  },
  {
    file: "access-cors.server",
    title:
      "ACE_WEB_ORIGINS configures the allowlist and rejects anything that is not an http(s) origin",
    reason: "configuration parsing and the local server's answers",
  },
  {
    file: "access-cors.server",
    title:
      "an allowed web app can set and clear this machine's code with an admin token, and nothing else opens up",
    reason: "an admin's pairing-code write through the local HTTP server",
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
];
// `machines/sni-keep-alive-on-node.process.test.ts` is a Node-only suite (`scripts/test-tiers.ts`)
// and the proof run's legs are Vitest on Bun, so its cases are owed on the Node pass instead.
