# Remote Access Setup

Use this when you want to open ace from another device (phone, tablet, another laptop).

## CLI ↔ Env option map

The ace server command (`ace serve`) accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                | Env var               | Notes                                                                                |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `--mode <web\|desktop>` | `ACE_MODE`            | Runtime mode.                                                                        |
| `--port <number>`       | `ACE_PORT`            | HTTP/WebSocket port.                                                                 |
| `--host <address>`      | `ACE_HOST`            | Bind interface/address.                                                              |
| `--base-dir <path>`     | `ACE_HOME`            | Base directory.                                                                      |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target.                                                   |
| `--no-browser`          | `ACE_NO_BROWSER`      | Disable auto-open browser.                                                           |
| `--auth-token <token>`  | `ACE_AUTH_TOKEN`      | WebSocket auth token. Use this for standard CLI and remote-server flows.             |
| `--bootstrap-fd <fd>`   | `ACE_BOOTSTRAP_FD`    | Read a one-shot bootstrap envelope from an inherited file descriptor during startup. |

> TIP: Use the `--help` flag to see all available options and their descriptions.

Other useful CLI commands:

- `ace daemon start|status|stop` for a persistent background server
- `ace remote add|list|remove` for saved remote host entries
- `ace project add|list|remove` for project catalog management without launching server runtime

## Security First

- Always set `--auth-token` before exposing the server outside localhost.
  - When you control the process launcher, prefer sending the auth token in a JSON envelope via `--bootstrap-fd <fd>`.
    With `--bootstrap-fd <fd>`, the launcher starts the server first, then sends a one-shot JSON envelope over the inherited file descriptor. This allows the auth token to be delivered without putting it in process environment or command line arguments.
- Treat the token like a password.
- Prefer binding to trusted interfaces (LAN IP or Tailnet IP) instead of opening all interfaces unless needed.

## Remote control mode behavior

- **Desktop app mode** can manage the local host plus multiple remote hosts.
- **URL/web mode** stores and manages only one remote host at a time.
- **Mobile app** supports multiple hosts and host switching.

## Two-way QR pairing (recommended)

Use this for initial authentication instead of manually sharing `ACE_AUTH_TOKEN`.

1. On the host device, open **Settings → Devices** and start a pairing session.
2. Scan the generated QR payload from the remote device.
3. Approve or reject the incoming request on the host device.
4. Once approved, the remote device saves the host and can connect immediately.

Pairing sessions are short-lived and expire automatically.

## 1) Build + run server for remote access

Remote access should use the built web app (not local Vite redirect mode).

```bash
bun run build
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --auth-token "$TOKEN" --no-browser
```

Then open on your phone:

`http://<your-machine-ip>:3773`

Example:

`http://192.168.1.42:3773`

Notes:

- `--host 0.0.0.0` listens on all IPv4 interfaces.
- `--no-browser` prevents local auto-open, which is usually better for headless/remote sessions.
- Ensure your OS firewall allows inbound TCP on the selected port.

## 2) Tailnet / Tailscale access

If you use Tailscale, you can bind directly to your Tailnet address.

```bash
TAILNET_IP="$(tailscale ip -4)"
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 --auth-token "$TOKEN" --no-browser
```

Open from any device in your tailnet:

`http://<tailnet-ip>:3773`

You can also bind `--host 0.0.0.0` and connect through the Tailnet IP, but binding directly to the Tailnet IP limits exposure.
