import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { agentSessionEnv } from "./agent-env.ts";

const thread = ThreadId.parse("t_9f2c41aa");

test("an agent session's shell names its own thread, never prompts, and finds its daemon's home", () => {
  expect(agentSessionEnv({ threadId: thread, home: "/home/a/.ace" })).toEqual({
    ACE_THREAD_ID: "t_9f2c41aa",
    ACE_NO_INPUT: "1",
    ACE_HOME: "/home/a/.ace",
  });
});

test("without a known home the session still gets its thread and no-input", () => {
  const env = agentSessionEnv({ threadId: thread });
  expect(env).toEqual({ ACE_THREAD_ID: "t_9f2c41aa", ACE_NO_INPUT: "1" });
  expect(Object.hasOwn(env, "ACE_HOME")).toBe(false);
});
