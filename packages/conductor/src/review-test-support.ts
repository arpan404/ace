import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConductorDriver, ConductorStore, executor, fakePorts, progress } from "./index.ts";
import type { ConductorSpec, State } from "./index.ts";
import { accounts, environment, plan, spec } from "./test-support.ts";

export function fixture(config: ConductorSpec = spec()) {
  const directory = mkdtempSync(join(tmpdir(), "ace-conductor-review-"));
  const path = join(directory, "run.sqlite");
  const env = environment();
  const fake = fakePorts(env.now);
  const store = new ConductorStore(path);
  const driver = new ConductorDriver(store, executor(fake.ports), env);
  let receipt = 0;
  driver.command("start", { type: "conductor.start", runId: "run", spec: config });
  driver.fact("run", "accounts", { type: "accounts", accounts });
  const state = (): State => {
    const current = store.load("run");
    if (!current) throw new Error("Run missing");
    return current;
  };
  const send = (input: unknown) => driver.fact("run", `fact-${++receipt}`, input);
  async function install(project = plan()) {
    await driver.drain("run");
    const planner = progress(state()).lanes[0];
    if (!planner) throw new Error("Planner missing");
    send({
      type: "artifact",
      laneId: planner.id,
      generation: planner.generation,
      artifact: { kind: "plan", plan: project },
    });
    send({
      type: "status",
      laneId: planner.id,
      generation: planner.generation,
      status: "done",
      at: env.now(),
    });
    await driver.drain("run");
  }
  function close() {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return { directory, path, env, fake, store, driver, state, send, install, close };
}
