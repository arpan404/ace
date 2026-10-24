import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  git,
  registered,
  repositoryWithOrigin,
  transferMachines,
} from "./transfer-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function originServer(answer: (response: ServerResponse) => void) {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    answer(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP listener");
  return { url: `http://127.0.0.1:${address.port}/private.git`, requests: () => requests };
}

async function sourceWithHistory(m: Awaited<ReturnType<typeof transferMachines>>, url: string) {
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  await git(path, "remote", "set-url", "origin", url);
  await writeFile(join(path, "next.txt"), "next\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "next");
  const workspaceId = await m.addProject(m.source, path);
  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
}

it("sends full history promptly when a private HTTP origin requires authentication", async () => {
  const origin = await originServer((response) => {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="private"' });
    response.end();
  });
  const m = await transferMachines({ cloneTimeoutMs: 5_000 });
  const started = performance.now();
  await sourceWithHistory(m, origin.url);
  const transfer = await m.settled();
  expect(performance.now() - started).toBeLessThan(15_000);
  expect(origin.requests()).toBeGreaterThan(0);
  expect(transfer).toMatchObject({ phase: "completed", method: "bundle" });
  const landed = transfer.result?.path ?? "";
  expect(await git(landed, "log", "--format=%s")).toBe("next\nfirst");
  expect(await git(landed, "remote", "get-url", "origin")).toBe(origin.url);
  expect(await git(landed, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
  expect(await git(landed, "log", "--format=%s", "origin/main")).toBe("first");
}, 30_000);

it("falls back to full history when the origin accepts a connection but never answers", async () => {
  const origin = await originServer(() => {});
  const m = await transferMachines({ cloneTimeoutMs: 300 });
  const started = performance.now();
  await sourceWithHistory(m, origin.url);
  const transfer = await m.settled();
  expect(performance.now() - started).toBeLessThan(15_000);
  expect(origin.requests()).toBeGreaterThan(0);
  expect(transfer).toMatchObject({ phase: "completed", method: "bundle" });
  const landed = transfer.result?.path ?? "";
  expect(await git(landed, "log", "--format=%s")).toBe("next\nfirst");
  expect(await git(landed, "remote", "get-url", "origin")).toBe(origin.url);
  expect(await git(landed, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
  expect(await git(landed, "log", "--format=%s", "origin/main")).toBe("first");
}, 30_000);

it("cancels a stalled origin clone and removes its partial project", async () => {
  const origin = await originServer(() => {});
  const m = await transferMachines({ cloneTimeoutMs: 30_000 });
  const before = registered(m.target);
  await sourceWithHistory(m, origin.url);
  await vi.waitFor(() => expect(origin.requests()).toBeGreaterThan(0), { timeout: 10_000 });
  const transferId = m.source.daemon.transfers.outgoing.list()[0]?.transferId;
  if (!transferId) throw new Error("Missing transfer");
  await m.source.daemon.transfers.outgoing.cancel(transferId);
  expect(await m.settled()).toMatchObject({ phase: "cancelled" });
  await vi.waitFor(() => expect(registered(m.target)).toEqual(before));
  await vi.waitFor(async () => expect(await readdir(m.targetRoot)).not.toContain("app"), {
    timeout: 5_000,
  });
}, 30_000);
