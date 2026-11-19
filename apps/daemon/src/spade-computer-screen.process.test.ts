// A real edge: ace's screen manager over its fake helper process, whose states (the holder
// cleared when the person takes the controls) are what the hand-back has to read correctly.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { ScreenManager } from "@ace/screen";
import { watchScreenUse } from "./services/spade-computers.ts";
import { ace } from "./spade/computers-test-support.ts";

const target = { kind: "window", bundleId: "dev.ace.test", windowId: 1 } as const;

async function screenManager() {
  const directory = await mkdtemp(join(tmpdir(), "spade-screen-"));
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper.ts", import.meta.url).pathname,
    ],
    env: { FAKE_V2: "1" },
    nextId: () => `screen-${++id}`,
    recordingDirectory: directory,
    publishArtifact: async () => {},
  });
  onTestFinished(async () => {
    await screen.close();
    await rm(directory, { recursive: true, force: true });
  });
  await screen.enable(true);
  return screen;
}

test("the person taking the controls of a screen session started for a bot counts as using its screen", async () => {
  const daemon = ace();
  const threadId = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "fares" })).ran);
  const screen = await screenManager();
  onTestFinished(watchScreenUse(screen, daemon.computers));
  await daemon.computers.drive("fares", "person");
  // The viewer starts a session for the bot's thread, then the person takes its controls.
  const session = await screen.start(target, 10, { threadId, agentId: "human" });
  screen.controller(session.sessionId, "human");
  expect(screen.state(session.sessionId)).toMatchObject({ controller: "human" });
  expect(screen.state(session.sessionId).holder).toBeUndefined();
  expect((await daemon.computers.drive("fares", "bot")).handback?.screenUsed).toBe(true);
});

test("a screen session for another thread never counts for a bot", async () => {
  const daemon = ace();
  await daemon.call("browser_tabs", { actingFor: "fares" });
  const screen = await screenManager();
  onTestFinished(watchScreenUse(screen, daemon.computers));
  await daemon.computers.drive("fares", "person");
  const session = await screen.start(target, 10, {
    threadId: ThreadId.parse("someone-else"),
    agentId: "human",
  });
  screen.controller(session.sessionId, "human");
  expect((await daemon.computers.drive("fares", "bot")).handback?.screenUsed).toBe(false);
});

test("a session delegated to a bot is that bot's screen when the person takes it, not the starter's", async () => {
  const daemon = ace();
  const fares = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "fares" })).ran);
  const news = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "news" })).ran);
  const screen = await screenManager();
  onTestFinished(watchScreenUse(screen, daemon.computers));
  await daemon.computers.drive("fares", "person");
  await daemon.computers.drive("news", "person");
  // Started for fares, handed to news's agent, then the person takes the controls.
  const session = await screen.start(target, 10, { threadId: fares, agentId: "human" });
  screen.delegateAgent(session.sessionId, { threadId: news, agentId: "agent-2" });
  screen.controller(session.sessionId, "human");
  expect(screen.state(session.sessionId)).toMatchObject({ controller: "human", threadId: fares });
  expect((await daemon.computers.drive("news", "bot")).handback?.screenUsed).toBe(true);
  expect((await daemon.computers.drive("fares", "bot")).handback?.screenUsed).toBe(false);
});

test("a bot's session handed to another thread's agent stops being the bot's screen", async () => {
  const daemon = ace();
  const fares = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "fares" })).ran);
  const screen = await screenManager();
  onTestFinished(watchScreenUse(screen, daemon.computers));
  await daemon.computers.drive("fares", "person");
  const session = await screen.start(target, 10, { threadId: fares, agentId: "human" });
  screen.delegateAgent(session.sessionId, {
    threadId: ThreadId.parse("someone-else"),
    agentId: "agent-9",
  });
  screen.controller(session.sessionId, "human");
  expect((await daemon.computers.drive("fares", "bot")).handback?.screenUsed).toBe(false);
});
