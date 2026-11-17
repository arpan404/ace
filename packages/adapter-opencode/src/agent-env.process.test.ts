import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { object } from "./data.ts";
import { setup, shellEnvironment, shellOutcome } from "./testing/v2-session.ts";

// Real edges: one fake `opencode serve` process shared by every session of an account, and the
// real child process it spawns for a shell command, whose environment is what is asserted.

const variables = (threadId: string) => ({
  ACE_THREAD_ID: threadId,
  ACE_NO_INPUT: "1",
  ACE_HOME: "/home/person/.ace",
});

/** Opens a thread on `h`'s adapter, with its own variables and frames. */
async function thread(h: Awaited<ReturnType<typeof setup>>, id: string, resume?: string) {
  const frames: Frame[] = [];
  const session = await h.adapter.openSession({
    threadId: ThreadId.parse(id),
    rootKey: "root",
    cwd: "/one",
    agentEnv: variables(id),
    signal: new AbortController().signal,
    onFrame: (frame) => frames.push(frame),
    onExit() {},
    ...(resume ? { resume: { nativeSessionId: resume } } : {}),
  });
  return { session, frames };
}

test("two threads on one account's OpenCode server each run shell commands with their own thread's variables", async () => {
  const h = await setup({
    discovery: {
      env: { PERSON_SETTING: "kept", OPENCODE_SERVER_PASSWORD: "person-server-password" },
    },
  });
  const a = await thread(h, "thread-a");
  const b = await thread(h, "thread-b");

  const inA = await shellEnvironment(h.transport(), a.session.nativeSessionId);
  const inB = await shellEnvironment(h.transport(), b.session.nativeSessionId);
  expect(inA).toMatchObject({ ...variables("thread-a"), PERSON_SETTING: "kept" });
  expect(inB).toMatchObject({ ...variables("thread-b"), PERSON_SETTING: "kept" });
  // OpenCode's server credentials are the server's; ace never starts its server with them.
  expect(inA.OPENCODE_PASSWORD).toBeUndefined();
  expect(inA.OPENCODE_SERVER_PASSWORD).toBeUndefined();

  // A session ace gave no variables (setup's own) names no thread at all, and still inherits
  // no credential.
  const unnamed = await shellEnvironment(h.transport(), h.session.nativeSessionId);
  expect(unnamed.ACE_THREAD_ID).toBeUndefined();
  expect(unnamed.PERSON_SETTING).toBe("kept");
  expect(unnamed.OPENCODE_PASSWORD).toBeUndefined();
  await a.session.close("shutdown");
  await b.session.close("shutdown");
});

test("a subagent's shell commands run with its root thread's variables", async () => {
  const h = await setup();
  const a = await thread(h, "thread-a");
  const root = a.session.nativeSessionId;
  const child = {
    id: "session-subagent",
    parentID: root,
    projectID: "project-one",
    location: { directory: "/one" },
  };
  await h.control("/test/state", { sessions: [child] });
  const from = a.frames.length;
  await h.control("/test/events", [
    {
      type: "session.created",
      directory: "/one",
      data: { ...child, id: undefined, sessionID: child.id },
    },
  ]);
  for (let tries = 0; ; tries++) {
    const applied = a.frames
      .slice(from)
      .some(
        (frame) =>
          frame.dir === "recv" &&
          object(frame.data).path === `/api/session/${child.id}/environment`,
      );
    if (applied) break;
    if (tries > 200) throw new Error("the subagent's environment was never set");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(await shellEnvironment(h.transport(), child.id)).toMatchObject(variables("thread-a"));
  await a.session.close("shutdown");
});

test("a session resumed on a newly started OpenCode server runs shell commands with its thread's variables", async () => {
  // A restarted daemon starts a new server, whose memory holds no session's environment.
  const h = await setup();
  const earlier = {
    id: "session-earlier",
    projectID: "project-one",
    location: { directory: "/one" },
    time: { created: 1, updated: 1, idle: 1 },
  };
  await h.control("/test/state", { sessions: [earlier] });
  const resumed = await thread(h, "thread-a", earlier.id);

  expect(resumed.session.nativeSessionId).toBe(earlier.id);
  expect(await shellEnvironment(h.transport(), earlier.id)).toMatchObject(variables("thread-a"));
  await resumed.session.close("shutdown");
});

test("the environment ace hands OpenCode is never recorded in the thread's frames", async () => {
  const h = await setup({ discovery: { env: { PERSON_TOKEN: "person-token-value" } } });
  const a = await thread(h, "thread-a");

  expect(await shellEnvironment(h.transport(), a.session.nativeSessionId)).toMatchObject({
    PERSON_TOKEN: "person-token-value",
  });
  expect(a.frames.some((frame) => JSON.stringify(frame.data).includes("person-token-value"))).toBe(
    false,
  );
  await a.session.close("shutdown");
});

/** A subagent of `root` that OpenCode just created, announced as OpenCode announces it. */
async function createSubagent(h: Awaited<ReturnType<typeof setup>>, root: string, id: string) {
  const child = { id, parentID: root, projectID: "project-one", location: { directory: "/one" } };
  await h.control("/test/state", { sessions: [child] });
  await h.control("/test/events", [
    {
      type: "session.created",
      directory: "/one",
      data: { ...child, id: undefined, sessionID: child.id },
    },
  ]);
}

test("a subagent that runs a shell the moment it exists sees its thread's variables and no credential", async () => {
  const h = await setup({
    discovery: { env: { ACE_MCP_BEARER_TOKEN: "ace-bearer-value", PERSON_SETTING: "kept" } },
  });
  const a = await thread(h, "thread-a");
  // Setting the subagent's environment is slow, and its first command doesn't wait for ace.
  await h.control("/test/state", { fault: { environmentDelayMs: 400 } });
  const [shell] = await Promise.all([
    shellOutcome(h.transport(), "session-eager"),
    createSubagent(h, a.session.nativeSessionId, "session-eager"),
  ]);

  expect(shell).toMatchObject({ env: { ...variables("thread-a"), PERSON_SETTING: "kept" } });
  const env = "env" in shell ? shell.env : {};
  expect(env.OPENCODE_PASSWORD).toBeUndefined();
  expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
  expect(env.ACE_MCP_BEARER_TOKEN).toBeUndefined();
  // Nor does the server itself hold ace's credentials for a shell to fall back to.
  const serverNames = await h.control("/test/server-env", {});
  expect(serverNames).not.toContain("ACE_MCP_BEARER_TOKEN");
  await a.session.close("shutdown");
});

test("a subagent whose environment can't be set is stopped and never runs a command", async () => {
  const h = await setup();
  const a = await thread(h, "thread-a");
  await h.control("/test/state", { fault: { environmentFailure: true } });
  const [shell] = await Promise.all([
    shellOutcome(h.transport(), "session-unset"),
    createSubagent(h, a.session.nativeSessionId, "session-unset"),
  ]);

  expect(shell).toMatchObject({ refused: expect.stringContaining("the tool did not run") });
  const requests = await h.control("/test/requests", {});
  expect(JSON.stringify(requests)).toContain("/api/session/session-unset/interrupt");
  expect(
    a.frames.some(
      (frame) =>
        frame.channel === "agent.environment" &&
        object(frame.data).type === "stopped" &&
        object(frame.data).sessionID === "session-unset",
    ),
  ).toBe(true);
  // A later command in it is refused at once, as ace said.
  expect(await shellOutcome(h.transport(), "session-unset")).toMatchObject({
    refused: expect.stringContaining("ACE_THREAD_ID"),
  });
  await a.session.close("shutdown");
});
