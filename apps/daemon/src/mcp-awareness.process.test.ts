import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import type { ThreadId } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";

let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
const childId = (text: string) =>
  z
    .object({ data: z.object({ threadId: z.string() }) })
    .parse(JSON.parse(text.split("\n")[0] ?? "")).data.threadId as ThreadId;

it("a new session already knows its project, branch, access and title state", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  expect(agent.instructions).toContain('Project "shop"');
  expect(agent.instructions).toContain('branch "feat/login"');
  expect(agent.instructions).toContain(
    "Full access: your provider runs tools without asking; ace adds no approvals",
  );
  expect(agent.instructions).toContain("Title is provisional");
  expect(agent.instructions).toMatch(/Delegate with delegate_task to: .*claude/);
});

it("the next ace result says what changed: a child waiting on the person, then one finishing", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  const role = { role: "implementer", provider: "claude" };
  const asking = childId(
    (await agent.call("delegate_task", { requestId: "a", task: "Ask first", ...role })).text,
  );
  const working = childId(
    (await agent.call("delegate_task", { requestId: "b", task: "Just do it", ...role })).text,
  );
  await agent.call("ace_status", {});
  await world.askHuman(asking);
  const waiting = await agent.call("ace_threads_list", {});
  expect(waiting.text).toContain(`child ${asking.slice(0, 8)}`);
  expect(waiting.text).toContain("is waiting on the person");
  expect(waiting.text).not.toMatch(new RegExp(`${asking.slice(0, 8)}[^;]*finished`));
  await world.complete(working, "Done");
  const settled = await agent.call("ace_status", {});
  expect(settled.text).toContain(`child ${working.slice(0, 8)} "implementer" finished`);
  expect(settled.text).not.toContain(asking.slice(0, 8));
  // Reported once: the next call has nothing new.
  expect((await agent.call("ace_status", {})).text).not.toContain("ace/changes");
});
