# 0097: Tailscale pairing links use the ts.net name and Tailscale's HTTPS certificate

Date: 2026-10-22. Status: accepted.

## Context

Over Tailscale, pairing links used to name the machine's internal 100.x address, and the remote
listener served only ace's self-signed certificate (`CN=ace`, no subject alternative names, ten
years). Native clients and the CLI trust it through the public-key pin carried in the link's
fragment. Browsers can't pin. They need a certificate they already trust, and Safari refuses a
self-signed server certificate without the hostname in its SAN, or one that lasts longer than
825 days, even after the person trusts it by hand. Pairing from a browser over Tailscale
therefore failed with a generic network error.

Tailscale gives every machine a MagicDNS name (`mac.tailnet.ts.net`). When the tailnet's
administrator turns on HTTPS certificates, `tailscale cert` issues a Let's Encrypt certificate
for that name. Only the machine holding the name can get one. Certificates last about 90 days,
and tailscaled renews them with a new key.

## Decision

- **Name.** In Tailscale mode, the pairing link's origin is the machine's MagicDNS name and the
  remote port (`https://mac.tailnet.ts.net:4243`) only while the listener is serving a valid
  Tailscale certificate for that name. Otherwise it is the 100.x address: when MagicDNS is off,
  HTTPS certificates are off, the fetch fails (Linux operator permission, tailscaled down), or
  the certificate expired while renewals kept failing. Without a trusted certificate the name buys
  nothing, and it fails on devices that don't use Tailscale's DNS. Each new link is decided when
  it is created. The listener always binds the Tailscale IPv4 address.
- **Certificate by SNI.** The listener serves the certificate Tailscale issues when a client asks
  for the ts.net name (`tailscale cert --cert-file - --key-file -`), and ace's own certificate for
  any other name, for clients that name nothing, and until Tailscale's certificate arrives. The
  daemon fetches it when the listener starts and every 12 hours, retrying every 10 minutes while
  it fails. A fetched chain is used only if its leaf names the host, is valid now and matches
  the key, so a bad issuance never replaces a working certificate. A failure is logged once per
  streak with the fix: turn on HTTPS certificates in the Tailscale admin console, or on Linux,
  `sudo tailscale set --operator=$USER`. The daemon keeps trying, so turning HTTPS on later
  needs no restart.
- **Client trust.** The pinned public key still authenticates a daemon. If the key doesn't match
  and the host is a `*.ts.net` name, the Node client and the iOS app accept the connection
  when the system trusts the chain for that exact name. They reject every other host whose pin
  doesn't match. The link's `fingerprint` stays ace's own key, so existing pairings keep working
  over the 100.x address, and over the ts.net name while Tailscale has no certificate.

## Consequences

- Browsers, including the hosted app at app.acehq.dev, can pair and connect over Tailscale with
  no certificate warning, once HTTPS certificates are on for the tailnet.
- For ts.net hosts, trust widens from "this exact key" to "a publicly trusted certificate for
  this exact name". Tailscale controls the ts.net zone, and traffic also travels inside the
  tailnet's WireGuard tunnel, so an attacker would need both a misissued certificate and a path
  into the tailnet.
- Turning on HTTPS certificates publishes the machine and tailnet names in public Certificate
  Transparency logs. Tailscale states this when the administrator turns the feature on; ace never
  turns it on.
- Android has no remote pairing yet. When it gets one, its trust check must follow the same rule.
- LAN access is unchanged: browsers there must still accept ace's self-signed certificate.
