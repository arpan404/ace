import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { runProcess, type Runner } from "./process.ts";
import { spadeServicePlan } from "./spade-plan.ts";
import { installSpadeBinary, installedSpadeVersion } from "./spade-release.ts";
import { installSpadeService } from "./spade-service.ts";
import { updateSpade } from "./spade-update.ts";

/**
 * The real edges of Spade's swap: its HTTP API (a local server standing in for Spade), a SQLite
 * backup of its database, and the new binary run with `--check-migrations`. Only the service
 * manager is faked; its restart starts a Spade answering with the binary `current` names.
 */
test.skipIf(process.platform === "win32")(
  "an update pauses Spade over HTTP, checks a copy of its database with the new binary, then restarts it",
  async ({ onTestFinished }) => {
    const world = await setup(onTestFinished, "exit 0");
    const result = await updateSpade({
      home: world.home,
      source: world.candidate,
      version: "0.5.0",
      mode: "now",
      plan: world.plan,
      io: { service: world.service, now: () => 0 },
    });
    expect(result).toEqual({ kind: "swapped", from: "0.4.0", to: "0.5.0" });
    expect(world.requests).toEqual([
      'POST /v1/maintenance {"mode":"now","deadline_ms":30000}',
      "GET /v1/maintenance",
    ]);
    expect(await installedSpadeVersion(world.home)).toBe("0.5.0");
    // The check ran on a copy, which is gone again; the live database is untouched.
    expect(await readFile(world.checked, "utf8")).toMatch(/spade-migration-check\/spade\.sqlite/);
    expect(existsSync(join(world.home, ".spade-migration-check"))).toBe(false);
  },
);

test.skipIf(process.platform === "win32")(
  "a new binary that refuses the database leaves the old Spade running with admission reopened",
  async ({ onTestFinished }) => {
    const world = await setup(onTestFinished, "echo 'schema 12 is newer than 0.5.0' >&2; exit 1");
    const result = await updateSpade({
      home: world.home,
      source: world.candidate,
      version: "0.5.0",
      mode: "idle",
      plan: world.plan,
      io: { service: world.service, now: () => 0 },
    });
    expect(result).toMatchObject({ kind: "failed", from: "0.4.0", to: "0.5.0" });
    expect(result.kind === "failed" && result.error).toMatch(/schema 12 is newer/);
    expect(world.requests.at(-1)).toBe("DELETE /v1/maintenance");
    expect(await installedSpadeVersion(world.home)).toBe("0.4.0");
    expect(world.restarts()).toBe(0);
  },
);

async function setup(onTestFinished: (fn: () => Promise<void>) => void, check: string) {
  const root = await mkdtemp(join(tmpdir(), "ace-spade-update-"));
  const servers: Server[] = [];
  onTestFinished(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, ".ace");
  const data = join(home, "spade");
  await mkdir(data, { recursive: true });
  const db = new DatabaseSync(join(data, "spade.sqlite"));
  db.exec("CREATE TABLE turns (id TEXT); INSERT INTO turns VALUES ('t1')");
  db.close();
  const checked = join(root, "checked-path");
  const binary = async (name: string, body: string) => {
    const path = join(root, name);
    await writeFile(path, `#!/bin/sh\nprintf '%s' "$2" > '${checked}'\n${body}\n`, { mode: 0o755 });
    return path;
  };
  await installSpadeBinary(home, await binary("old-spade", "exit 0"), "0.4.0");
  const candidate = await binary("new-spade", check);

  const requests: string[] = [];
  let admission = "open";
  let version = "0.4.0";
  let restarts = 0;
  const listen = async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        if (request.url === "/health") {
          response.end(JSON.stringify({ ok: true, version, api: 1 }));
          return;
        }
        if (request.headers.authorization !== `Bearer ${"t".repeat(32)}`) {
          response.statusCode = 401;
          response.end();
          return;
        }
        requests.push(`${request.method} ${request.url}${body ? ` ${body}` : ""}`);
        if (request.method === "POST") admission = "closed";
        if (request.method === "DELETE") admission = "open";
        response.end(JSON.stringify({ admission, running_turns: 0, running_jobs: 0 }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await writeFile(join(data, "token"), "t".repeat(32));
    await writeFile(
      join(data, "server.json"),
      JSON.stringify({ address: `127.0.0.1:${port}`, pid: 1, version, api: 1 }),
    );
  };
  await listen();

  const plan = spadeServicePlan(home, "darwin", { userHome: root, uid: 501 });
  let loaded = false;
  const run: Runner = async (file, args) => {
    if (file !== "launchctl") return runProcess(file, args);
    if (args[0] === "print")
      return loaded
        ? {
            code: 0,
            stderr: "",
            stdout: `\tpath = ${plan.file}\n\tstate = running\n\tprogram = ${plan.command[0]}\n\targuments = {\n\t\t${plan.command[0]}\n\t}\n`,
          }
        : { code: 113, stderr: "", stdout: "" };
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "kickstart") {
      restarts += 1;
      version = (await installedSpadeVersion(home)) ?? "";
      admission = "open";
      await listen();
    }
    return { code: 0, stderr: "", stdout: "" };
  };
  const service = { run, wait: async () => {} };
  await installSpadeService(plan, service);
  return { home, plan, candidate, requests, checked, service, restarts: () => restarts };
}
