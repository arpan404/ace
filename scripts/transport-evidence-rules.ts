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

/** The number of lines an instance carries for one event inside the window. */
function eventLines(view: WindowView, instance: number, event: string): EvidenceLine[] {
  return view.lines.filter((line) => line.instance === instance && line.event === event);
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
      "the case's one bind, its close-requested with bound: true and a close with no connections and no handled traffic: the listener the retire outran never served",
    check(view) {
      const binds = boundRemote(view);
      if (binds.length !== 1) return `${binds.length} binds; the case leaves exactly one, closed`;
      const late = binds[0];
      if (late === undefined) return "no bind line";
      // The case's own retire is remote-direct's call, which holds no listener whose bind is in
      // flight: no listener line can see it, so the gate is what it left behind — a bind closed
      // before it served anything.
      const requested = view.lines.find(
        (line) =>
          line.instance === late.instance &&
          line.event === "close-requested" &&
          line.bound === true,
      );
      if (requested === undefined)
        return `no close-requested with bound: true for the instance that bound on port ${late.port}`;
      const close = late.close;
      if (close === undefined) return `the instance that bound on port ${late.port} has no close`;
      if ((close.connections ?? 0) !== 0)
        return `the close on port ${late.port} counts connections, so the late listener served`;
      const served = view.lines.some(
        (line) =>
          line.instance === late.instance &&
          line.event === "handled" &&
          ((line.connections ?? 0) > 0 || (line.exchanges ?? 0) > 0 || (line.upgrades ?? 0) > 0),
      );
      if (served) return `a handled line on port ${late.port} counts traffic, so it served`;
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
      if (eventLines(view, only.instance, "close").length === 0)
        return `no close for the instance that bound on port ${only.port}`;
      return undefined;
    },
  },
  {
    file: "native-remote.process",
    title:
      "a LAN port taken at start is reported, and once freed the listener serves on the next retry",
    proof: "bind-failed EADDRINUSE, then a bind on the port, then a handled line with exchanges",
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
      if (eventLines(view, bound.instance, "handled").length === 0)
        return `no handled line for the instance that bound on port ${port}`;
      const counts = ownedOf(view, bound);
      if (counts === undefined || counts.exchanges <= 0)
        return `no exchanges on port ${port} after its bind`;
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
            listener.instance !== first.instance &&
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
      'the client-side half only: raw TLS fixtures (`serve`) check the pin, while the native listener\'s half of the decision is "the native listener serves the trusted ts.net certificate, and the pin for every other name"',
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
  // A Node-only suite (`scripts/test-tiers.ts`): the proof run gives it a Node leg, so the same
  // cases are checked against the native listener on the runtime release builds use.
  "apps/daemon/src/machines/sni-keep-alive-on-node.process.test.ts",
];
