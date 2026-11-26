# Deploying ace's push gateway

ace's push gateway ([ADR 0106](../adr/0106-ios-remote-push-gateway.md)) is the only hosted
service ace runs ([ADR 0002](../adr/0002-local-cli-providers.md), amended). It forwards encrypted
alert payloads from a person's own daemon to APNs and, as of #2758, starts and updates Live
Activities ([ADR 0223](../adr/0223-one-live-activity-per-machine-driven-by-its-daemon.md),
[live-activity-push.md](../specs/live-activity-push.md)).

Nothing in the repository provisions the host, creates DNS, or stores secrets. The owner picks the
platform and runs this checklist once. Until it is done, shipped iOS builds keep ADR 0087 behaviour
even after Release carries `aps-environment` (#2763).

The implementation lives in `apps/push-gateway`. The image is `apps/push-gateway/Dockerfile`.

## Before you start

- Read ADR 0106's privacy model: the gateway sees device tokens, timing and ciphertext only.
- Have ace's Apple Developer team ready for bundle id `app.ace.ios`.
- Choose a host that can hold a **long-lived outbound HTTP/2 connection** to Apple on TCP 443.
  Cloudflare Workers alone cannot; a small VPS or container service is typical.
- Inbound HTTPS must terminate in front of the container (Caddy, a load balancer, or the platform
  proxy). The proxy must pass the client IP in `X-Forwarded-For` when the gateway is not exposed
  directly.

## Checklist

Each step is **Owner** unless noted.

### 1. Apple Developer setup

1. Confirm the Team ID for the team that owns `app.ace.ios`.
2. In Certificates, Identifiers & Profiles:
   - Enable **Push Notifications** and **App Groups** on `app.ace.ios`.
   - Create `app.ace.ios.notifications` (the notification service extension) with App Groups.
   - Create the app group `group.app.ace.ios` and add it to the app and the NSE.
   - Regenerate provisioning profiles used for TestFlight and App Store archives.
3. **APNs auth key.** Keys › create a key with Apple Push Notifications service (Sandbox &
   Production). Download the `.p8` once; note the Key ID. Store it only in the gateway's secret
   store, never in git.
4. **Handle-sealing key.** Generate one:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

### 2. Host and DNS

1. Choose where the container runs and how it restarts on failure.
2. Point the public name at it (default `push.acehq.dev`). If the name differs, change the
   default in `packages/settings/src/defaults.ts` (`notifications.pushGatewayUrl`) and set
   `ACE_PUSH_PUBLIC_ORIGIN` on the gateway to the same HTTPS origin.
3. TLS certificates for that name on the front proxy.

### 3. Build and run the container

From a checkout at the release you intend to run (or a pinned image digest built from it):

```sh
docker build -f apps/push-gateway/Dockerfile -t ace-push-gateway .
```

Mount the APNs `.p8` read-only, or inject its PEM via `ACE_PUSH_APNS_KEY`. Run as an unprivileged
user (the image already uses `node`).

### 4. Environment

Set these on the container (no defaults for secrets):

| Variable                 | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `ACE_PUSH_APNS_TEAM_ID`  | Apple team id                                            |
| `ACE_PUSH_APNS_KEY_ID`   | APNs key id                                              |
| `ACE_PUSH_APNS_KEY_FILE` | Path to mounted `.p8`, **or**                            |
| `ACE_PUSH_APNS_KEY`      | Contents of the `.p8`                                    |
| `ACE_PUSH_APNS_TOPIC`    | `app.ace.ios`                                            |
| `ACE_PUSH_SEAL_KEY`      | Base64url sealing key from step 1.4                      |
| `ACE_PUSH_PUBLIC_ORIGIN` | `https://push.acehq.dev` (must match daemon VAPID `aud`) |
| `ACE_PUSH_TRUST_PROXY`   | `1` when behind a proxy that sets `X-Forwarded-For`      |
| `ACE_PUSH_PORT`          | Listen port (default `8788`)                             |

During a sealing-key rotation, set the previous key in `ACE_PUSH_SEAL_KEY_PREVIOUS` until handles
expire or daemons re-register.

Optional tuning (defaults in ADR 0106 and [live-activity-push.md](../specs/live-activity-push.md)):
`ACE_PUSH_LIMIT_PER_IP`, `ACE_PUSH_LIMIT_REGISTRATIONS`, `ACE_PUSH_LIMIT_PUSHES`,
`ACE_PUSH_LIMIT_PER_HANDLE`.

### 5. Smoke test (alerts)

1. `curl -fsS https://push.acehq.dev/healthz` — body `ok`.
2. `curl -fsS https://push.acehq.dev/v1/capabilities` — JSON includes
   `"kinds":["alert","liveactivity","start"]`. A `404` here means an older gateway image;
   redeploy from a commit that includes #2758 / PR #2771.
3. On a **development** build with `ACE_PUSH=YES` against a sandbox gateway (or production, if
   you only have TestFlight builds), enable notifications on a paired machine, lock the phone,
   and let an agent finish or ask for approval. The lock-screen text should show the thread title
   from the NSE, not the gateway's generic "New activity".
4. Confirm the daemon shows a push address for the phone after the app registers a token.

### 6. Smoke test (Live Activity, after daemon and app ship)

Follow [live-activity-push.md](../specs/live-activity-push.md) rollout: gateway first, then daemon,
then app. On a device with Live Activities enabled, lock the phone, start work on the Mac, and
confirm the per-machine activity appears and stays within its stale window. Counts on the Lock Screen
never carry thread titles (ADR 0145).

### 7. App Store privacy

Declare the device token as data collected for app functionality, not linked to identity, not used
for tracking. Align with `docs/releasing-ios-app-store.md`.

### 8. Monitoring and rotation

- Alert on elevated `5xx` rates from the gateway (container logs are JSON lines: route and status
  only).
- **APNs key rotation:** create the new key in Apple, deploy it on the gateway, revoke the old
  key.
- **Sealing key rotation:** move the current key to `ACE_PUSH_SEAL_KEY_PREVIOUS`, set a new
  `ACE_PUSH_SEAL_KEY`, deploy; daemons re-register as handles fail.

## What shipped iOS needs

Release builds set `ACE_PUSH: YES` in `apps/ios/project.yml` with `ACE_APS_ENVIRONMENT:
production`, so TestFlight and App Store binaries include `aps-environment`. Without a reachable
gateway at the URL daemons use (`https://push.acehq.dev` by default), tokens register but nothing
is delivered.

Self-hosters run the same image with their own APNs key and bundle id, and point
`notifications.pushGatewayUrl` (or `ACE_PUSH_GATEWAY_URL`) at their origin.

## Related issues

- #2763 acceptance: gateway health and capabilities, TestFlight token registration, encrypted
  alerts with ace closed, Allow/Deny from the lock screen.
- Daemon Live Activity scheduling: #2759, #2760, #2762. iOS tokens and UI: #2761.
