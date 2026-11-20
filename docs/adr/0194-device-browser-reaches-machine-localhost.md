# 0194: A device's own browser opens the machine's localhost

Status: proposed. Date: 2026-11-19. Decided by: the owner, 2026-11-19 (ports, agent tabs, web
app); the phone's mechanism waits on the spike below. Amends
[ADR 0008](0008-preview-gateway.md) (preview gateway, which said browsers can't use the relay),
[ADR 0088](0088-remote-browser-view-v2.md) (remote clients only watch ace's Chrome) and
[ADR 0114](0114-fastest-path.md) (paths).

## Context

A person away from the machine (on the phone, or in the desktop app connected to another
machine) sees a thread's pages only as video of ace's Chrome on the machine. That is right for a
tab an agent is working in: the person sees exactly what the agent sees. It is wrong for a page the
person just wants to use, such as their own dev server. Scrolling, typing, autofill, text
selection and zoom all go through a picture of a browser on the other machine.

Opening `localhost:3000` in the device's own browser fails, because localhost is the device. The
preview gateway (ADR 0008) puts a dev server on a device's own browser, but only one port at a
time, under a `p<port>-<generation>` hostname, over loopback, the LAN or Tailscale. The page's
origin is not `localhost:3000`, so a frontend calling `localhost:4000`, an OAuth redirect to
localhost or a CORS allowlist breaks.

The client already reaches each machine over its fastest working path: same computer, LAN,
Tailscale, the person's relay, ace's relay (ADR 0114).

## Decision

### Loopback goes to the machine, everything else goes direct

In ace's own apps, a page the person opens loads in the device's own engine: `WKWebView` on the
phone, Chromium in the desktop app. ace splits that browser's connections by hostname, on the
device:

- `localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]` go to the machine, through a tunnel on
  the path the client is already on.
- Every other host connects straight from the device, on the device's own network.

The page keeps its real origin (`http://localhost:3000`), so other localhost ports, redirects,
CORS allowlists and secure-context features (localhost counts as potentially trustworthy) behave
as they do on the machine. The tunnel carries TCP bytes, not HTTP. Websockets (hot reload),
server-sent events, uploads and HTTPS dev servers pass through unchanged, and nothing on the way
parses or rewrites them.

Each machine has its own cookie and storage partition on the device, so `localhost:3000` on one
machine never sees sign-ins made against `localhost:3000` on another.

The desktop app splits them with a proxy on the device; the phone takes the loopback ports
themselves, because iOS never sends loopback to a proxy (see "The device side"). Where a hostname
rule is needed, it is one pure function in `@ace/ui-core`.

### Which pages run where

- **Tabs an agent works in stay in ace's Chrome on the machine,** shown as video (ADR 0088).
  Agents keep the full browser toolset there; nothing about browser use changes.
- **Pages the person opens on a remote device run on that device.** These device tabs are the
  person's own. Agents don't see or drive them. An agent's tab offers "Open on this phone" (or
  "this device"), which opens the same URL as a device tab. Sign-ins don't carry over: ace's
  Chrome and the device keep separate profiles.
- **The desktop app on the machine's own computer** is unchanged. Its native view already runs
  there, and localhost is already the machine.
- **The web app in an ordinary browser tab** is unchanged. It keeps showing ace's Chrome as video.
  A web page can't set a proxy for itself.

### Which ports

A paired device with `operate` authority may reach any TCP port on the machine's loopback. That
gives nothing it lacked: such a device can already run commands on the machine through agents
and terminals. Read-only devices are refused. A per-machine setting turns the tunnel off.

The tunnel always refuses every port an ace process listens on, whatever the device asks for:
the daemon's listeners, the preview gateway and Spade's service. A tunnelled connection arrives at
the machine from loopback, and loopback is what those listeners trust. The refused ports are never
a stored list, and the guard does not depend on polling:

- Every listener in the daemon's own process is held as ace's synchronously as it binds, before
  it can accept: on Node through the listen tracing channel, which also covers servers no list
  names (the MCP endpoint, git leases, page probes); on any runtime for the daemon's named
  listeners, from their `listening` event. A dev server is always another process.
- ace's other processes register through what they already publish: Spade's port from its
  `server.json`, read live.
- A scan of the daemon's, Spade's and ace-media's processes supplements both. It is one pass over
  the OS tables, shared with the port list devices hear (one `lsof` on macOS, one `netstat` on
  Windows, the socket tables and only those processes' descriptors on Linux). An open whose last
  scan is over a second old waits for a fresh one, shared with every other open.

The last check runs synchronously as the stream's socket connects, and again once it has
connected, before any byte moves. Without a successful scan in the last five seconds, a port no
source names is unknown, and unknown is refused: the guard fails closed. A port that becomes ace's
(Spade starting on a port a stream already uses) resets every stream open to it.

The desktop app's SOCKS proxy (see "The device side") is an ace listener on the loopback of the
computer it runs on, and it reaches another machine with this device's credentials. A device
tunnelled to that computer must not reach it, so the proxy demands a per-launch secret (SOCKS5
user and password that only its own sessions know) and refuses any connection without it.

The daemon connects only to `127.0.0.1` or `::1` on the requested port. The device names a port,
never a host.

### The tunnel

- **Transport.** The tunnel uses the path the client's machine connection is on (same computer,
  LAN, Tailscale or a relay), and is authenticated the same way. It runs on its own connection,
  so a large bundle download never delays agent state behind it on a slow link. Its framing is
  `@ace/preview`'s existing stream protocol (OPEN, READY, DATA, CREDIT, END, RESET, with per-stream
  credit), carried in binary messages, never JSON or Base64.
- **Path switches.** When the client moves to a better path, new streams open on the new path.
  Streams already open finish on the old one, which closes once they have ended or after a bounded
  wait. A stream cut by a lost path is reset. The browser retries the request and hot reload
  reconnects, as after any dropped connection.
- **Connection.** A tunnel connection says `hello` with `channel: "tunnel"` and the path's own
  credential: a one-use ticket on a direct path (under the listener's pinned key), the paired
  token inside a relay's Noise stream. Its welcome must name the expected daemon, on every path.
  After the welcome the machine sends `tunnel.ports` (the whole listening set, again only when it
  changes) and `tunnel.refused` (with a stream id for one OPEN, before that stream's RESET;
  without one for the whole tunnel, which then closes). Refusals are `tunnel_off`,
  `tunnel_forbidden`, `tunnel_port_refused` and `tunnel_limit`. A port with nothing listening is
  a plain RESET, which the client reports as `tunnel_reset`. Once its hello is read, a tunnel
  connection carries only its stream frames and pings: its other JSON reaches no service,
  command or read, whatever the device's scopes. Its authority is decided before any frame is
  handled.
- **Reconnects.** After a drop the client reconnects on a backoff (250 ms up to 10 s), and opens
  honour it: an open while the machine is unreachable waits for the next scheduled attempt,
  shared with every other open. The backoff starts over only once the machine has accepted the
  tunnel (its port list or a stream), since a refusal can follow the welcome. The client opens
  the tunnel as a device tab opens, not at its first request.
- **Limits.** 256 open streams per device across its tunnel connections, 100 opens a second
  after a burst of 200, and at most 64 opens waiting for authorization across the daemon. Every
  OPEN is charged as it arrives, before anything is allocated for it, refused ones included, and
  a device's bucket is kept until it has refilled, so closing streams buys no opens back. A
  stream's slot is freed the moment the mux removes it. Per stream at most the mux's window
  (256 KiB) is buffered each way, written to the loopback socket one write at a time with frames
  that arrive meanwhile joined into the next; across a connection at most 32 MiB waits for its
  sockets, and a stream past it is reset. Excess opens are refused with `tunnel_limit`, never
  queued.
- **Revocation.** Revoking a device, removing its `operate` authority or turning the tunnel off
  ends its open streams at once. The refusal is sent first, then every TCP stream is destroyed,
  and the connection closes once the refusal is written or after two seconds, so the device
  hears why and backs off instead of retrying the path.

### The device side

- **Desktop app.** Each remote machine gets a session partition with
  `setProxy({ proxyRules: "socks5://127.0.0.1:<port>", proxyBypassRules: "*,<-loopback>" })`,
  pointing at a SOCKS5 proxy in the main process. `*` sends every host direct and `<-loopback>`
  then takes loopback back from Chromium's built-in bypass. The order matters: the last matching
  rule wins, so `<-loopback>,*` sends everything direct. Chromium hands SOCKS5 the hostname
  unresolved, so the proxy sees `localhost`, `foo.localhost`, `127.0.0.1` or `::1` and a port,
  then moves bytes. HTTP, websockets and HTTPS all arrive the same way. A PAC script can't do
  this: Chromium bypasses loopback for PAC results regardless.
- **Phone.** iOS sends `localhost` and the loopback addresses straight to the phone, whatever
  proxy is set (spike 1), so the phone takes the ports themselves. While a device tab of a machine
  is in front, the app listens on the phone's `127.0.0.1` and `::1` on each port the machine is
  listening on at loopback, minus ace's own. Each connection it accepts opens a tunnel stream to the
  machine on the same port. `localhost:3000`, `127.0.0.1:3000`, `[::1]:3000` and
  `foo.localhost:3000` all land there, so no hostname rule is needed on iOS. Every other host goes
  direct, with no proxy set at all.
  - The machine's listening ports come from the daemon's existing port discovery (ADR 0008's
    `pollPorts`), sent over the tunnel connection as changes only. The page's own port is
    listened on even before discovery reports it.
  - A listener can't tell which web view connected, so a port serves one machine at a time:
    the machine of the device tab in front. Switching to another machine's device tab moves the
    listeners to that machine. Each machine keeps its own `WKWebsiteDataStore` (iOS 17 or later,
    keyed by the machine), so cookies stay apart.
  - A port already taken on the phone isn't listened on. A page that needs it says which port is
    busy.
  - The listeners close when the last device tab closes. While they're open, other apps on the
    phone could connect to them too, the way any app can reach another app's loopback port.
  - Swift only owns the listeners and moves bytes. Which ports to take and which machine owns them
    are decided in the shared JavaScript, behind the native host contract.
- **Android**, later: `ProxyController` with `removeImplicitRules()`.

### Public pages don't reach the machine's localhost

On the device, a public page could otherwise `fetch("http://localhost:…")` and reach the
machine through the tunnel. Electron launches with Chromium's Local Network Access checks turned
off, so the spike saw such a request go through with no preflight. A device tab therefore blocks
loopback requests whose top-level page is not itself on a loopback host:

- desktop app: the partition's `webRequest.onBeforeRequest` cancels a loopback request when its
  frame's top-level URL isn't loopback;
- phone: a `WKContentRuleList` blocks loopback URLs `unless-top-url` is loopback.

Top-level navigations to loopback are allowed, so an OAuth flow that leaves for a provider and
redirects back to `localhost` still works.

### Spikes

1. **WebKit, answered 2026-11-19: no.** On an iPhone with iOS 27.2.1, a store's
   `proxyConfigurations` carried `foo.localhost` and public hosts but not `localhost`,
   `127.0.0.1` or `[::1]`, for pages, `fetch` and websockets alike. The iOS 26.1 simulator did
   carry `localhost`, because it uses the Mac's network stack, so loopback behaviour must be
   tested on a device. A listener in the app on the same port served `localhost`, both IP literals
   and `foo.localhost`, and was still serving after the app had been in the background for a
   minute.
2. **Electron, answered 2026-11-19.** Electron 44.5.1 (Chromium 152) on macOS, partition session
   as above: `localhost`, `127.0.0.1`, `[::1]`, `foo.localhost`, cross-port `fetch`, websockets
   and HTTPS all went through the proxy. Public hosts went direct, and the default session and
   other partitions were unaffected. `window.isSecureContext` stays true and the origin keeps its
   value. Chromium retries a failed HTTPS connect once, so the tunnel sees a duplicate open.
3. **A Vite-like dev page, answered 2026-11-19** (`apps/daemon/bench/machine-tunnel.ts`). A
   dev server in its own process served an HTML page, its entry script and a two-level graph of
   300 modules (about 2 KB each, 302 requests). A loader stood in for the browser: HTTP/1.1,
   keep-alive, six connections, each module fetched once its importer arrived. The slow-link
   shaper (`@ace/perf-kit/link`) sat on the device's leg, in front of the daemon's TLS listener
   or of a local relay (apps/relay). "No tunnel" is the same loader straight to the dev server
   over the same link: the floor. Load average about 10 on 12 cores.

   | Link    | Path      | Tunnel up | First paint | Full load |
   | ------- | --------- | --------: | ----------: | --------: |
   | lan     | no tunnel |         — |       11 ms |    161 ms |
   | lan     | direct    |     51 ms |       14 ms |    210 ms |
   | lan     | relay     |     33 ms |       11 ms |    272 ms |
   | 3g-fast | no tunnel |         — |      935 ms |    18.4 s |
   | 3g-fast | direct    |     2.2 s |      924 ms |    21.3 s |
   | 3g-fast | relay     |     1.2 s |      927 ms |    21.1 s |
   | 3g-slow | no tunnel |         — |       1.9 s |    29.3 s |
   | 3g-slow | direct    |     3.7 s |       1.3 s |    33.0 s |
   | 3g-slow | relay     |     2.3 s |       1.3 s |    32.7 s |

   On 3G the tunnel costs 12 to 15% of full load over the floor, the same on either path: the
   page is bound by HTTP/1.1's round trips (302 requests over six connections), which the tunnel
   neither adds nor removes. First paint matches the floor once the tunnel is up (the floor's
   includes its first TCP handshake). The tunnel itself comes up while the device tab opens: about
   seven round trips on a direct path (TLS for the ticket exchange, TLS for the socket, the
   hello), four on a relay. A direct path can drop the exchange by keeping the next ticket the
   welcome hands out (ADR 0150), a follow-up.

## Consequences

- A person on the phone uses their dev server in a real mobile browser, with the machine's
  localhost, from any network ace reaches the machine on.
- A device with `operate` authority can now reach every loopback service on the machine, such as
  databases or local model servers, not only the dev servers ace found. That was already possible
  through an agent's shell. The per-machine switch turns it off.
- An HTTPS dev server's certificate (a local CA, for example) is checked by the device, which
  usually doesn't trust it. The device shows its own certificate error. Trusting a machine's local
  CA is not part of this decision.
- Agents can't see what a person does in a device tab. A page the person wants an agent to look at
  has to be opened in ace's Chrome.
- The preview gateway stays for the web app's "Open outside" and for browsers that are not ace's.

## Alternatives rejected

- **Rewrite URLs to per-port hostnames** (ADR 0008's gateway). The origin changes, so pages that
  call other localhost ports or redirect to localhost break.
- **Show every page as video of ace's Chrome.** Right for agents, wrong for a person using their
  own page.
- **Let the relay read the HTTP.** Simpler, and websockets would work without a tunnel, but the
  relay would see the dev server's traffic. The relay stays end-to-end encrypted.
- **Let agents drive the phone's `WKWebView`.** It has no automation protocol like Chrome's
  DevTools Protocol. Agents keep ace's Chrome.
