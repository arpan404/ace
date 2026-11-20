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
phone, Chromium in the desktop app. Each such browser sends its connections through a proxy that
ace runs on the device. The proxy decides per connection by hostname:

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

The hostname rule is one pure function in `@ace/ui-core`, shared by every client.

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
the machine from loopback, and loopback is what those listeners trust. The daemon reads the
refused ports from its own listeners when each stream opens, never from a stored list, so a
listener that moved to another port is still refused.

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
- **Limits.** Streams per device, open attempts per second and buffered bytes per stream are
  capped. Excess opens are reset, never queued without bound.
- **Revocation.** Revoking a device, removing its `operate` authority or turning the tunnel off
  ends its open streams at once.

### The device side

- **Desktop app.** Each remote machine gets a session partition with
  `setProxy({ proxyRules: "socks5://127.0.0.1:<port>", proxyBypassRules: "*,<-loopback>" })`,
  pointing at a SOCKS5 proxy in the main process. `*` sends every host direct and `<-loopback>`
  then takes loopback back from Chromium's built-in bypass. The order matters: the last matching
  rule wins, so `<-loopback>,*` sends everything direct. Chromium hands SOCKS5 the hostname
  unresolved, so the proxy sees `localhost`, `foo.localhost`, `127.0.0.1` or `::1` and a port,
  then moves bytes. HTTP, websockets and HTTPS all arrive the same way. A PAC script can't do
  this: Chromium bypasses loopback for PAC results regardless.
- **Phone.** The app runs a CONNECT proxy on its own loopback (`NWListener`). Each machine's
  `WKWebsiteDataStore` (iOS 17 or later, keyed by the machine) has its `proxyConfigurations` set
  to that proxy. The Swift side only moves bytes between the local socket and the tunnel. The
  decisions stay in the shared JavaScript, behind the native host contract.
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

1. **Does WebKit send loopback through `proxyConfigurations`?** Apple doesn't document it. If it
   doesn't, the phone listens on its own `127.0.0.1:<port>` for each port it has seen the page
   use, and forwards that. The origin stays the same, but the listeners only live while the app
   is open, and a port can belong to one machine at a time.
2. **Electron, answered 2026-11-19.** Electron 44.5.1 (Chromium 152) on macOS, partition session
   as above: `localhost`, `127.0.0.1`, `[::1]`, `foo.localhost`, cross-port `fetch`, websockets
   and HTTPS all went through the proxy. Public hosts went direct, and the default session and
   other partitions were unaffected. `window.isSecureContext` stays true and the origin keeps its
   value. Chromium retries a failed HTTPS connect once, so the tunnel sees a duplicate open.
3. **A Vite dev page over ace's relay** on the slow-link harness (hundreds of module requests,
   each a stream). Its time to first paint and full load set the bar for the tunnel. This runs
   with the first tunnel build, since it needs the tunnel.

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
