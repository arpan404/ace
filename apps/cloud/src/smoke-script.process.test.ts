import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/*
 * The release smoke (scripts/smoke.ts) runs as its own Node process against a live host. A host
 * that accepts connections and never answers must fail the smoke within its deadlines, not hang
 * it: a hung smoke would hold a release with no rollback.
 */
const script = fileURLToPath(import.meta.resolve("../scripts/smoke.ts"));
let server: Server | undefined;
const sockets: Socket[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const socket of sockets) socket.destroy();
  server?.close();
});

/** A host that takes every connection and says nothing. */
async function silentHost(): Promise<string> {
  server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("the ace cloud smoke", () => {
  it("fails, rather than hangs, against a host that never answers", async () => {
    const origin = await silentHost();
    const child = spawn("node", [script, origin], {
      env: { ...process.env, ACE_SMOKE_TIMEOUT_MS: "400" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(1);
    expect(output).toContain("FAIL  a daemon without a grant is refused");
    expect(output).toContain("FAIL  a client without a grant is refused");
  }, 20_000);
});
