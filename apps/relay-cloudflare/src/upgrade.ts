/**
 * WebSocket upgrade responses from the relay object.
 *
 * A refusal known before the 101 is sent must not use a hibernatable socket: workerd holds the
 * TCP connection of a hibernatable socket closed inside `fetch()` for about ten seconds after
 * the close frame, so the client only learns it was refused when its own timeout fires. A plain
 * socket, accepted and closed at once, ends the connection with the close handshake.
 */
export function refuseUpgrade(code: number, reason: string, protocol?: string): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  server.close(code, reason);
  return upgraded(client, protocol);
}

/** The 101 response. A requested subprotocol must be echoed or `ws` clients fail the upgrade. */
export function upgraded(client: WebSocket, protocol?: string): Response {
  return new Response(null, {
    status: 101,
    webSocket: client,
    ...(protocol ? { headers: { "Sec-WebSocket-Protocol": protocol } } : {}),
  });
}
