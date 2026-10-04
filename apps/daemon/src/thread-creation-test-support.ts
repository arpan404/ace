import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { Command, DeviceId, type ThreadId, type CommandPayload } from "@ace/protocol";
import { Client, token } from "./socket-test-support.ts";
import { until } from "./projects-test-support.ts";

export const git = promisify(execFile);
export async function repository(home: string) {
  await git("git", ["init", "-b", "main", home]);
  await writeFile(join(home, "file.txt"), "Synthetic\n");
  await git("git", ["-C", home, "add", "file.txt"]);
  await git("git", [
    "-C",
    home,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@ace.local",
    "commit",
    "-m",
    "Initial",
  ]);
}
export async function connect(url: string) {
  const client = new Client(url);
  await once(client.socket, "open");
  client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("device"), token });
  expect(await client.next()).toMatchObject({ type: "welcome" });
  return client;
}
export async function command(client: Client, id: string, payload: CommandPayload) {
  client.send({ type: "command", command: Command.parse({ id, deviceId: "device", payload }) });
  return until(client, (message) => message.type === "commandResult" && message.commandId === id);
}
export async function queue(client: Client, threadId: ThreadId) {
  client.send({ type: "queue.get", requestId: "queue", threadId });
  const result = await until(client, (message) => message.type === "queue.result");
  if (result.type !== "queue.result") throw new Error("Expected queue");
  return result.queue;
}
