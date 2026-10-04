import { randomUUID } from "node:crypto";
import { ServerMessage, type CommandPayload, type CommandResult } from "@ace/protocol";

/**
 * Commands sent to the e2e daemon the way any client sends them (hello, then a command and its
 * result), for seeding threads and for journeys whose other side is another device.
 */
export async function daemonCommands(
  url: string,
  token: string,
  payloads: readonly CommandPayload[],
  deviceId = "e2e-seed",
): Promise<CommandResult[]> {
  const socket = new WebSocket(url);
  const ids = payloads.map(() => randomUUID());
  const results = new Map<string, CommandResult>();
  const done = new Promise<CommandResult[]>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const parsed = ServerMessage.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) return;
      const reply = parsed.data;
      if (reply.type === "error" && !("requestId" in reply && reply.requestId))
        reject(new Error(String(event.data)));
      if (reply.type !== "commandResult") return;
      if (!reply.ok) reject(new Error(`${reply.commandId} failed: ${reply.error}`));
      results.set(reply.commandId, reply);
      if (results.size === ids.length) resolve(ids.flatMap((id) => results.get(id) ?? []));
    });
    socket.addEventListener("error", () => reject(new Error("Daemon socket failed")));
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId, token }));
  payloads.forEach((payload, index) =>
    socket.send(
      JSON.stringify({ type: "command", command: { id: ids[index], deviceId, payload } }),
    ),
  );
  try {
    return await done;
  } finally {
    socket.close();
  }
}
