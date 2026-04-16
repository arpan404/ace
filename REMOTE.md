# Remote Access

Use this when you want to connect to an ace server from another device (phone, tablet, or another desktop app).

## Recommended Setup

Use a trusted private network that meshes your devices together (for example a tailnet).

That gives you:

- a stable address to connect to
- transport security at the network layer
- less exposure than opening the server to the public internet

## Enabling Network Access

There are two ways to expose your server for remote connections: desktop app or CLI.

### Option 1: Desktop App

1. Open **Settings** → **Devices**.
2. Under **Host this device**, ensure your backend is reachable from your network (bind your server to a LAN or tailnet interface).
3. Use **Create Link** to generate a one-time pairing link.
4. Share the pairing link (or QR) with the remote device.

### Option 2: Headless Server (CLI)

Use this when running the server without GUI (for example over SSH):

```bash
ace serve --host "$(tailscale ip -4)"
```

From there, connect another device by:

- scanning a pairing QR generated from host settings
- pasting the full pairing link in **Add remote host**
- or entering a direct host URL (`ws://...`) with token

Use `ace serve --help` for full flags. It supports the normal server startup options, including `--host`, `--port`, and optional `cwd`.

> Note
> GUI support for fully managing remote machine projects is still evolving.
> For now, use CLI project commands on the server machine when needed.

## How Pairing Works

The remote device does not need a long-lived secret up front.

1. Host creates a one-time pairing session.
2. Remote device claims that session using the pairing link.
3. Host approves the claim and the remote receives an authenticated host session.

After pairing, future access is session-based. You only need a new pairing link when pairing a new device.

## Security Notes

- Treat pairing links and auth tokens like passwords.
- Prefer binding `--host` to a trusted private address (LAN/tailnet) instead of broad public exposure.
- Anyone with a valid pairing credential can create a session until it expires or is revoked.
- Remove stale remote hosts and regenerate pairing links when trust changes.
