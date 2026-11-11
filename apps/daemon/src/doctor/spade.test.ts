import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  installSpadeBinary,
  installedSpadeVersion,
  type SpadeServiceState,
} from "@ace/service/spade";
import type { DoctorContext } from "./feature.ts";
import { spadeFeature, type SpadePorts } from "./spade.ts";
import { doctorTestContext } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup(overrides: Partial<DoctorContext> = {}) {
  const made = await doctorTestContext(overrides);
  cleanups.push(made.cleanup);
  return made;
}

function ports(state: SpadeServiceState | Error, ace = "0.5.0"): SpadePorts {
  return {
    state: async () => {
      if (state instanceof Error) throw state;
      return state;
    },
    installed: installedSpadeVersion,
    aceVersion: async () => ace,
  };
}

async function run(context: DoctorContext, spadePorts: SpadePorts, id: string) {
  const check = spadeFeature(spadePorts)
    .checks(context)
    .find((candidate) => candidate.id === id);
  if (!check) throw new Error(`missing check ${id}`);
  return check.run(new AbortController().signal);
}

async function install(dataDir: string, version: string) {
  const source = join(dataDir, "..", `spade-${version}`);
  await writeFile(source, "spade", { mode: 0o755 });
  await installSpadeBinary(dataDir, source, version);
}

it("Spade turned off is fine: no service and no binary", async () => {
  const { context } = await setup();
  expect((await run(context, ports("absent"), "spade.service")).status).toBe("ok");
  expect((await run(context, ports("absent"), "spade.binary")).status).toBe("ok");
});

it("a registered Spade that isn't running warns and points at its log", async () => {
  const { context, dataDir } = await setup();
  await install(dataDir, "0.5.0");
  const verdict = await run(context, ports("stopped"), "spade.service");
  expect(verdict.status).toBe("warn");
  expect(verdict.fix).toMatch(/spade\.log/);
});

it("a service ace didn't write fails with the service check's reason", async () => {
  const { context } = await setup();
  const verdict = await run(
    context,
    ports(new Error("Incompatible Spade service at plist")),
    "spade.service",
  );
  expect(verdict).toMatchObject({ status: "fail", message: "Incompatible Spade service at plist" });
});

it("a registered service whose binary is gone fails", async () => {
  const { context } = await setup();
  expect((await run(context, ports("running"), "spade.binary")).status).toBe("fail");
});

it("a Spade behind ace's version warns until the next update brings it along", async () => {
  const { context, dataDir } = await setup();
  await install(dataDir, "0.4.0");
  const behind = await run(context, ports("running", "0.5.0"), "spade.binary");
  expect(behind).toMatchObject({ status: "warn", message: "Spade is at 0.4.0 and ace at 0.5.0." });
  expect((await run(context, ports("running", "0.4.0"), "spade.binary")).status).toBe("ok");
});

it.skipIf(process.platform === "win32")(
  "a current pointer leading out of Spade's releases fails",
  async () => {
    const { context, dataDir } = await setup();
    await install(dataDir, "0.5.0");
    const current = join(dataDir, "releases/spade/current");
    await rm(current);
    await symlink("/usr/bin", current);
    expect((await run(context, ports("running"), "spade.binary")).status).toBe("fail");
  },
);

it("a build without Spade reports it left out", async () => {
  const { context } = await setup({ env: { DISABLE_SPADE: "1" } });
  const verdict = await run(context, ports(new Error("never asked")), "spade.service");
  expect(verdict).toMatchObject({ status: "ok", message: "This build leaves Spade out." });
});
