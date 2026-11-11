import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { withInstallLock } from "./files.ts";
import type { Runner } from "./process.ts";
import { spadeServicePlan } from "./spade-plan.ts";
import { spadeProof } from "./spade-proof.ts";
import { reopenSpadeAdmission } from "./spade-update.ts";

const token = "t".repeat(32);

/** A home whose Spade service is registered, launchd reporting it `state`, and Spade's HTTP API. */
async function setup(onTestFinished: (fn: () => Promise<void>) => void, state: string) {
  const root = await mkdtemp(join(tmpdir(), "ace-spade-reopen-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, ".ace");
  await mkdir(join(home, "spade"), { recursive: true });
  await writeFile(join(home, "spade/token"), token);
  await writeFile(
    join(home, "spade/server.json"),
    JSON.stringify({ address: "127.0.0.1:4100", pid: 7 }),
  );
  const plan = spadeServicePlan(home, "darwin", { userHome: root, uid: 501 });
  await mkdir(dirname(plan.file), { recursive: true });
  await writeFile(plan.file, plan.content);
  const run: Runner = async () => ({
    code: 0,
    stderr: "",
    stdout: `\tpath = ${plan.file}\n\tstate = ${state}\n\tprogram = ${plan.command[0]}\n\targuments = {\n\t\t${plan.command[0]}\n\t}\n`,
  });
  const sent: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const at = new URL(String(url));
    if (at.pathname === "/health") {
      const nonce = at.searchParams.get("nonce") ?? "";
      return Response.json({ ok: true, version: "0.4.0", proof: spadeProof(token, nonce) });
    }
    sent.push(`${init?.method ?? "GET"} ${at.pathname}`);
    return Response.json({ admission: "open", running_turns: 0, running_jobs: 0 });
  }) as typeof fetch;
  const reopen = () =>
    reopenSpadeAdmission(home, {
      plan,
      io: { fetch: fetcher, service: { run, wait: async () => {} } },
    });
  return { home, sent, reopen };
}

test("recovery reopens a running Spade's admission when no updater is swapping it", async ({
  onTestFinished,
}) => {
  const world = await setup(onTestFinished, "running");
  expect(await world.reopen()).toBe("reopened");
  expect(world.sent).toEqual(["DELETE /v1/maintenance"]);
});

test("recovery leaves Spade alone while another updater's swap holds its lock", async ({
  onTestFinished,
}) => {
  const world = await setup(onTestFinished, "running");
  const result = await withInstallLock(join(world.home, ".spade-update"), () => world.reopen());
  expect(result).toBe("busy");
  expect(world.sent).toEqual([]);
});

test("recovery doesn't reach for a Spade whose service isn't running", async ({
  onTestFinished,
}) => {
  const world = await setup(onTestFinished, "waiting");
  expect(await world.reopen()).toBe("not-running");
  expect(world.sent).toEqual([]);
});
