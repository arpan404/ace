import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Command, type MessageContextItem, type ThreadId } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { fakeHeadlessBackend } from "./browser-mcp-test-support.ts";

let running: EvalWorld | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** The login page every tab of the fake browser shows, as Chromium's accessibility tree. */
const loginPage = [
  {
    nodeId: "1",
    ignored: false,
    role: { value: "RootWebArea" },
    name: { value: "Sign in" },
    childIds: ["2", "3"],
    backendDOMNodeId: 1,
  },
  {
    nodeId: "2",
    ignored: false,
    role: { value: "textbox" },
    name: { value: "Email" },
    backendDOMNodeId: 5,
  },
  {
    nodeId: "3",
    ignored: false,
    role: { value: "button" },
    name: { value: "Continue" },
    backendDOMNodeId: 7,
  },
];

async function browsing() {
  const world = await evalWorld({ browser: false, browserBackend: fakeHeadlessBackend(loginPage) });
  running = world;
  const { agent, threadId } = await world.agent({});
  const opened = await agent.call("ace_browser_open", { url: "https://example.com/login" });
  const { tabId } = z.object({ tabId: z.string() }).parse(opened.data);
  await world.endTurn(threadId);
  return { world, threadId, tabId };
}

/** The person sends `text` pointing at `items`, and the agent's provider receives it. */
async function send(
  world: EvalWorld,
  threadId: ThreadId,
  text: string,
  items: MessageContextItem[],
) {
  const engine = world.daemon.engine;
  if (!engine) throw new Error("Missing engine");
  const command = Command.parse({
    id: `send-${items.length}-${text.length}`,
    deviceId: "person",
    payload: {
      type: "thread.send",
      threadId,
      delivery: "queue",
      input: [{ type: "text", text }],
      context: { mentions: [], attachments: [], items },
    },
  });
  expect(
    world.store.recordCommand(command.id, command.deviceId, () =>
      engine.handler.handle(command, world.store),
    ),
  ).toMatchObject({ ok: true });
  for (let attempt = 0; attempt < 400; attempt++) {
    await world.flush();
    const received = world.received(threadId).join("\n");
    if (received.includes(text) && received.includes("<browser_")) return received;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`The agent never received: ${world.received(threadId).join("\n")}`);
}

it("a message mentioning a browser tab reaches the agent with the tab's id, address, a fresh snapshot and its screenshot", async () => {
  const { world, threadId, tabId } = await browsing();
  const received = await send(world, threadId, "Why won't this log me in?", [
    { type: "browser_tab", tabId, url: "https://example.com/login", title: "Sign in" },
  ]);
  expect(received).toContain(`<browser_tab tabId="${tabId}" url="https://example.com/login"`);
  // A snapshot taken at delivery, with refs the agent can act on in that tab.
  expect(received).toMatch(/- button "Continue" \[ref=e\d+-7\]/);
  expect(received).toMatch(/- textbox "Email" \[ref=e\d+-5\]/);
  expect(received).toContain("Its screenshot is attached to this message.");

  const items = world.store.readItemPage(threadId, world.store.headSeq() + 1, 50).items;
  const asked = items.find(
    (item) =>
      item.type === "message" &&
      item.role === "user" &&
      item.parts.some((part) => part.type === "text" && part.text.includes("log me in")),
  );
  expect(asked).toMatchObject({
    attachments: [
      expect.objectContaining({ mimeType: "image/jpeg", name: `browser-tab-${tabId}.jpg` }),
    ],
  });
});

it("a mention of a tab that has since closed still tells the agent which tab the person meant", async () => {
  const { world, threadId } = await browsing();
  const received = await send(world, threadId, "Look at the pricing tab", [
    {
      type: "browser_tab",
      tabId: "closed-tab",
      url: "https://example.com/pricing",
      title: "Pricing",
    },
  ]);
  expect(received).toContain(
    '<browser_tab tabId="closed-tab" url="https://example.com/pricing" title="Pricing" unavailable=',
  );
});

it("annotated elements reach the agent as refs in the tab they were made in", async () => {
  const { world, threadId, tabId } = await browsing();
  const received = await send(world, threadId, "Make these bigger", [
    {
      type: "browser_annotations",
      tabId,
      url: "https://example.com/login",
      annotations: [
        { number: 1, role: "button", name: "Continue" },
        { number: 2, role: "link", name: "Forgot password" },
      ],
    },
  ]);
  expect(received).toContain(`<browser_annotation_refs tabId="${tabId}"`);
  expect(received).toMatch(/\[1\] ref=e\d+-7/);
  expect(received).toContain("[2] no unique element found");
});
