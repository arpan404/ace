# ace relay

Standalone self-hostable relay for ace remote connections.

## Start

```bash
bun run src/server.ts
```

## Environment

- `ACE_RELAY_HOST`
- `ACE_RELAY_PORT`
- `ACE_RELAY_PUBLIC_URL`
- `ACE_RELAY_PAIRING_TTL_MS`
- `ACE_RELAY_IDLE_ROUTE_TTL_MS`
- `ACE_RELAY_MAX_FRAME_BYTES`
- `ACE_RELAY_MAX_CONNECTIONS`
- `ACE_RELAY_LOG_LEVEL`

## Endpoints

- `GET /healthz`
- `GET /metrics`
- `WS  /v1/ws`

## Notes

- The relay forwards opaque encrypted frames only.
- It does not decrypt transport payloads.
- It does not durably store traffic payloads.
