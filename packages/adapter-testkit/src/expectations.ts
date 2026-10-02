import { readFile } from "node:fs/promises";
import { AgentStatus, InteractionState, Item, ThreadStatus } from "@ace/protocol";
import { z } from "zod";
import type { ReplayResult, TimelineEntry } from "./replay.ts";

const threadState = z.enum(ThreadStatus.options.map((option) => option.shape.state.value));
const agentState = z.enum(AgentStatus.options.map((option) => option.shape.state.value));
const itemType = z.enum(Item.options.map((option) => option.shape.type.value));
const waitingOn = ThreadStatus.options[2].shape.on;
const statusFields = {
  thread: threadState,
  on: waitingOn.optional(),
  agentStates: z.record(z.string(), agentState).optional(),
};
function validOn(value: { thread: string; on?: string | undefined }): boolean {
  return value.on === undefined || value.thread === "waiting";
}
const checkpoint = z
  .strictObject({
    t: z.number().int().nonnegative(),
    ...statusFields,
    note: z.string().optional(),
  })
  .refine(validOn, { message: "on is only valid for waiting", path: ["on"] });

export const Expectations = z.strictObject({
  checkpoints: z.array(checkpoint),
  final: z
    .strictObject({
      ...statusFields,
      agents: z.number().int().nonnegative().optional(),
      items: z.partialRecord(itemType, z.number().int().nonnegative()).optional(),
      interactions: z.partialRecord(InteractionState, z.number().int().nonnegative()).optional(),
    })
    .refine(validOn, { message: "on is only valid for waiting", path: ["on"] }),
});
export type Expectations = z.infer<typeof Expectations>;

export async function readExpectations(path: string): Promise<Expectations> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return Expectations.parse(value);
  } catch (error) {
    throw new Error(`${path}: ${String(error)}`, { cause: error });
  }
}

function equal(where: string, label: string, expected: unknown, actual: unknown): void {
  if (expected !== actual)
    throw new Error(`${where} expected ${label}${String(expected)}, got ${String(actual)}`);
}
function assertStatus(
  where: string,
  actual: Pick<TimelineEntry, "thread" | "agents">,
  expected: z.infer<typeof checkpoint> | Expectations["final"],
): void {
  equal(where, "", expected.thread, actual.thread.state);
  if (expected.on !== undefined)
    equal(
      where,
      "waiting on ",
      expected.on,
      actual.thread.state === "waiting" ? actual.thread.on : undefined,
    );
  for (const [key, state] of Object.entries(expected.agentStates ?? {})) {
    const agent = Object.hasOwn(actual.agents, key) ? actual.agents[key] : undefined;
    equal(where, `agent ${key} `, state, agent?.state ?? "missing");
  }
}

export function assertExpectations(result: ReplayResult, input: Expectations): void {
  const expected = Expectations.parse(input);
  for (const point of expected.checkpoints) {
    const where = `at t=${point.t}`;
    const actual = result.timeline.find((entry) => entry.t === point.t);
    if (!actual)
      throw new Error(`${where} was not replayed; pass checkpoint times to replayFixture`);
    assertStatus(where, actual, point);
  }
  const last = result.timeline.at(-1);
  assertStatus(
    "final",
    { thread: result.final.thread, agents: last?.agents ?? {} },
    expected.final,
  );
  if (expected.final.agents !== undefined)
    equal("final", "agents=", expected.final.agents, result.final.agents);
  for (const [type, count] of Object.entries(expected.final.items ?? {}))
    equal(
      "final",
      `items.${type}=`,
      count,
      result.final.items[type as keyof typeof result.final.items],
    );
  for (const [state, count] of Object.entries(expected.final.interactions ?? {}))
    equal(
      "final",
      `interactions.${state}=`,
      count,
      result.final.interactions[state as keyof typeof result.final.interactions],
    );
}
