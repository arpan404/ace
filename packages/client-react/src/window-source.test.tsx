import { Client } from "@ace/client";
import { FakeDaemon, ScenarioPlayer, facts, fakeTransport, type Scenario } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import {
  ClientProvider,
  ThreadWindowProvider,
  useAgent,
  useClient,
  useItem,
  useItemOrder,
  useThreadStore,
  windowSource,
} from "./index.ts";

const clients: Client[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** Thirty exchanges, so the daemon's snapshot (10 items) leaves the early ones out. */
function longThread(): Scenario {
  const steps: Scenario["steps"] = [{ kind: "facts", facts: [facts.rootAgent("claude")] }];
  for (let n = 1; n <= 30; n++)
    steps.push({
      kind: "facts",
      label: `exchange-${n}`,
      facts: [
        facts.message("root", `ask-${n}`, "user", `Question ${n}`),
        { type: "turn.started", agent: "root", nativeTurnId: `turn-${n}`, trigger: "user" },
        facts.message("root", `answer-${n}`, "assistant", `Answer ${n}`),
        { type: "turn.ended", agent: "root", nativeTurnId: `turn-${n}`, outcome: "completed" },
      ],
    });
  steps.push({
    kind: "facts",
    label: "answer-31",
    facts: [
      facts.message("root", "ask-31", "user", "Question 31"),
      { type: "turn.started", agent: "root", nativeTurnId: "turn-31", trigger: "user" },
      facts.message("root", "answer-31", "assistant", "Answer 31"),
      { type: "turn.ended", agent: "root", nativeTurnId: "turn-31", outcome: "completed" },
    ],
  });
  steps.push({
    kind: "facts",
    label: "working",
    facts: [{ type: "turn.started", agent: "root", nativeTurnId: "turn-32", trigger: "user" }],
  });
  return {
    thread: { id: "thread-long", workspaceId: "ws", title: "Long", provider: "claude" },
    steps,
  };
}

function setup() {
  let now = 1;
  let ids = 0;
  const daemon = new FakeDaemon({ clock: () => (now += 1), snapshotItems: 10 });
  const client = new Client({
    deviceId: DeviceId.parse("window-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++ids}`,
  });
  clients.push(client);
  return { daemon, client };
}

function Row(props: { id: string }) {
  const item = useItem("thread-long", props.id);
  const text =
    item?.type === "message"
      ? item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
      : "";
  return <li>{text}</li>;
}
function Transcript() {
  const order = useItemOrder("thread-long") ?? [];
  return (
    <ul aria-label="items">
      {order.map((id) => (
        <Row key={id} id={id} />
      ))}
    </ul>
  );
}
function RootStatus() {
  const store = useThreadStore("thread-long");
  const root = useAgent("thread-long", store?.thread?.rootAgentId ?? "");
  return <output aria-label="root">{root?.status.state ?? "?"}</output>;
}

/** Jumps to a turn the way the thread screen does, and shows it through the window. */
function Jumped(props: { turn: number; joined?: boolean }) {
  const client = useClient();
  const live = useThreadStore("thread-long");
  const [items, setItems] = useState<Parameters<typeof windowSource>[1]>();
  const source = live && items ? windowSource(live, items) : undefined;
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void client
            .itemsWindow({ threadId: "thread-long", turnOrdinal: props.turn, before: 0, after: 20 })
            .then((reply) =>
              setItems({ items: reply.items, before: reply.itemsBefore, joined: props.joined }),
            )
        }
      >
        Jump
      </button>
      <ThreadWindowProvider threadId="thread-long" source={source}>
        <Transcript />
        <RootStatus />
      </ThreadWindowProvider>
    </>
  );
}

test("a jumped window shows old items in place of the tail while the rest stays live", async () => {
  const { daemon, client } = setup();
  const script = new ScenarioPlayer(daemon, longThread());
  script.runThrough("exchange-30");
  await client.start();
  render(
    <ClientProvider client={client}>
      <Jumped turn={1} />
    </ClientProvider>,
  );
  await screen.findByText("Answer 30");
  expect(screen.queryByText("Question 1")).toBeNull();

  await act(async () => screen.getByRole("button", { name: "Jump" }).click());
  await screen.findByText("Question 1");
  expect(screen.getByText("Answer 1")).toBeTruthy();
  expect(screen.queryByText("Answer 30")).toBeNull();
  expect(screen.getByRole("status", { name: "root" }).textContent).toBe("idle");

  // A new turn starts: the agent's status is live inside the window, its items aren't added.
  await act(async () => script.runThrough("working"));
  await screen.findByText("working");
  expect(screen.queryByText("Answer 31")).toBeNull();
});

test("a window joined to the tail keeps its older items and follows the tail's new ones", async () => {
  const { daemon, client } = setup();
  const script = new ScenarioPlayer(daemon, longThread());
  script.runThrough("exchange-30");
  await client.start();
  render(
    <ClientProvider client={client}>
      <Jumped turn={24} joined />
    </ClientProvider>,
  );
  await screen.findByText("Answer 30");
  // The live tail holds the newest ten items only.
  expect(screen.queryByText("Question 24")).toBeNull();

  await act(async () => screen.getByRole("button", { name: "Jump" }).click());
  await screen.findByText("Question 24");
  await act(async () => script.runThrough("answer-31"));
  await screen.findByText("Answer 31");
  const texts = screen.getAllByRole("listitem").map((row) => row.textContent);
  expect(texts.indexOf("Question 24")).toBeLessThan(texts.indexOf("Answer 30"));
  expect(texts.indexOf("Answer 30")).toBeLessThan(texts.indexOf("Answer 31"));
  expect(texts.filter((text) => text === "Answer 30")).toHaveLength(1);
});
