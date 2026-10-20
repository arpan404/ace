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
    .object({ data: z.object({ threadIds: z.tuple([z.string()]) }) })
    .parse(JSON.parse(text.split("\n")[0] ?? "")).data.threadIds[0] as ThreadId;

it("a new session already knows its project, branch and access", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  expect(agent.instructions).toContain('Project "shop"');
  expect(agent.instructions).toContain('branch "feat/login"');
  expect(agent.instructions).toContain(
    "Full access: your provider runs tools without asking; ace adds no approvals",
  );
  expect(agent.instructions).toMatch(/Delegate \(tool delegate\) to: .*claude/);
});

it("the next ace result says what changed: a child waiting on the person, then one finishing", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  const asking = childId(
    (
      await agent.call("delegate", {
        tasks: [
          { requestId: "a", task: "Ask first", role: "ask-first-question", provider: "claude" },
        ],
      })
    ).text,
  );
  const working = childId(
    (
      await agent.call("delegate", {
        tasks: [
          { requestId: "b", task: "Just do it", role: "just-do-it-task", provider: "claude" },
        ],
      })
    ).text,
  );
  await agent.call("context", { topics: ["status"] });
  await world.askHuman(asking);
  const waiting = await agent.call("threads_find", {});
  expect(waiting.text).toContain(`child ${asking.slice(0, 8)}`);
  expect(waiting.text).toContain("is waiting on the person");
  expect(waiting.text).not.toMatch(new RegExp(`${asking.slice(0, 8)}[^;]*finished`));
  await world.complete(working, "Done");
  const settled = await agent.call("context", { topics: ["status"] });
  expect(settled.text).toContain(`child ${working.slice(0, 8)} "just-do-it-task" finished`);
  expect(settled.text).not.toContain(asking.slice(0, 8));
  // Reported once: the next call has nothing new.
  expect((await agent.call("context", { topics: ["status"] })).text).not.toContain("ace/changes");
});
