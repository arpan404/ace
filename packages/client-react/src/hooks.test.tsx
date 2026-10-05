import { Client, ConductorClient } from "@ace/client";
import {
  FakeDaemon,
  ScenarioPlayer,
  facts,
  fakeTransport,
  flakyCheckout,
  workbenchServices,
  type Scenario,
} from "@ace/fake-daemon";
import { DeviceId, InteractionId } from "@ace/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  ClientProvider,
  useAgentTree,
  useInteractions,
  useInteraction,
  useItemInteraction,
  useItem,
  type AgentTreeNode,
} from "./index.ts";

const clients: Client[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

test("a deck worker question remains visible when another component subscribes and unmounts", async () => {
  const { daemon, client } = setup();
  daemon.seedServices(workbenchServices(1_800_000_000_000));
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  let ids = 0;
  const decks = new ConductorClient(client, () => `deck-${++ids}`);
  const run = await decks.get("mobile-cold-start");
  const gate = run.needsUser.find((entry) => entry.kind === "provider");
  if (!gate?.threadId || !gate.interactionId) throw new Error("Missing worker question");
  const threadId = gate.threadId;
  const interactionId = gate.interactionId;
  const reporting = run.delegations
    .filter((entry) => entry.threadId !== threadId)
    .slice(0, 4)
    .map((entry) => client.thread(entry.threadId));
  function Question({ label }: { label: string }) {
    const interaction = useInteraction(threadId, interactionId);
    const text =
      interaction?.request.kind === "question" ? interaction.request.questions[0]?.text : "";
    return <output aria-label={label}>{text}</output>;
  }
  const view = (second: boolean) => (
    <ClientProvider client={client}>
      <Question key="deck" label="deck" />
      {second && <Question key="activity" label="activity" />}
    </ClientProvider>
  );
  const mounted = render(view(false));
  const text = "Ship the precompiled bytecode in the APK, or build it on the first launch?";
  await waitFor(() => expect(screen.getByLabelText("deck").textContent).toBe(text));
  mounted.rerender(view(true));
  await waitFor(() => {
    expect(screen.getByLabelText("deck").textContent).toBe(text);
    expect(screen.getByLabelText("activity").textContent).toBe(text);
  });
  mounted.rerender(view(false));
  await act(async () => {});
  expect(screen.getByLabelText("deck").textContent).toBe(text);
  for (const lease of reporting) lease.release();
});

function setup() {
  let now = 1;
  let ids = 0;
  const daemon = new FakeDaemon({ clock: () => (now += 1) });
  const client = new Client({
    deviceId: DeviceId.parse("hooks-device"),
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

/** Finds an item id by its visible text through the public store. */
function itemIdWithText(client: Client, threadId: string, text: string): string {
  const lease = client.thread(threadId);
  const id = lease.store.order.find((itemId) => {
    const item = lease.store.item(itemId);
    return (
      item?.type === "message" &&
      item.parts.some((part) => part.type === "text" && part.text.startsWith(text))
    );
  });
  lease.release();
  if (!id) throw new Error(`No item starting with ${text}`);
  return id;
}

test("a streaming message re-renders only the rows that selected it", async () => {
  const { daemon, client } = setup();
  const script = new ScenarioPlayer(daemon, flakyCheckout());
  script.step();
  script.step();
  await client.start();
  const renders = new Map<string, number>();
  function Row(props: { id: string }) {
    const item = useItem("thread-checkout", props.id);
    renders.set(props.id, (renders.get(props.id) ?? 0) + 1);
    const text =
      item?.type === "message"
        ? item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
        : "";
    return <p data-testid={props.id}>{text}</p>;
  }
  // Subscribe once so ids are known, then render one row per item.
  const lease = client.thread("thread-checkout");
  await act(async () => {});
  const ask = itemIdWithText(client, "thread-checkout", "checkout.spec.ts");
  const plan = itemIdWithText(client, "thread-checkout", "I'll look");
  render(
    <ClientProvider client={client}>
      <Row id={ask} />
      <Row id={plan} />
    </ClientProvider>,
  );
  await screen.findByText("I'll look for timing assumptions");
  const askRenders = renders.get(ask);

  await act(async () => script.step());
  await screen.findByText("I'll look for timing assumptions in the checkout flow first.");
  expect(renders.get(ask)).toBe(askRenders);
  lease.release();
});

const approval = (interaction: string, title: string) => ({
  type: "interaction.opened" as const,
  agent: "root",
  interaction,
  blocking: true,
  request: {
    kind: "approval" as const,
    title,
    options: [{ id: "allow", label: "Allow", kind: "allow_once" as const }],
  },
});
function twoApprovals(): Scenario {
  return {
    thread: { id: "thread-two", workspaceId: "ws", title: "Two approvals", provider: "claude" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          approval("first", "First?"),
          approval("second", "Second?"),
        ],
      },
    ],
  };
}

function Pending() {
  const ids = useInteractions("thread-two");
  return <output aria-label="pending">{(ids ?? []).join(",")}</output>;
}

test("a resolved interaction leaves the pending list while the thread still needs you", async () => {
  const { daemon, client } = setup();
  new ScenarioPlayer(daemon, twoApprovals()).runUntilBlocked();
  await client.start();
  render(
    <ClientProvider client={client}>
      <Pending />
    </ClientProvider>,
  );
  const output = await screen.findByLabelText("pending");
  await act(async () => {});
  const [first, second] = (output.textContent ?? "").split(",");
  expect(first && second).toBeTruthy();

  await act(async () => {
    await client.enqueue({
      type: "interaction.resolve",
      interactionId: InteractionId.parse(first),
      resolution: { kind: "approval", optionId: "allow" },
    });
  });
  await act(async () => {});
  expect(screen.getByLabelText("pending").textContent).toBe(second);
});

function Tree() {
  return <output aria-label="tree">{JSON.stringify(shape(useAgentTree("thread-tree")))}</output>;
}
const shape = (nodes: readonly AgentTreeNode[] | undefined): unknown =>
  nodes?.map((node) => shape(node.children) ?? []);

test("the agent tree re-nests a subagent when it is linked under another parent", async () => {
  const { daemon, client } = setup();
  const script = new ScenarioPlayer(daemon, {
    thread: { id: "thread-tree", workspaceId: "ws", title: "Tree", provider: "codex" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("codex"),
          facts.turn("root"),
          facts.subagent("codex", "a", "a", "spawn-a"),
          facts.turn("a", "spawn"),
          facts.subagent("codex", "b", "b", "spawn-b"),
          facts.turn("b", "spawn"),
        ],
      },
      // Late linkage moves b under a. Only the tree shape changes; no status event follows.
      { kind: "facts", facts: [{ type: "agent.linked", agent: "b", parent: "a" }] },
    ],
  });
  script.step();
  await client.start();
  render(
    <ClientProvider client={client}>
      <Tree />
    </ClientProvider>,
  );
  await act(async () => {});
  expect(screen.getByLabelText("tree").textContent).toBe("[[[],[]]]");
  await act(async () => script.step());
  await act(async () => {});
  expect(screen.getByLabelText("tree").textContent).toBe("[[[[]]]]");
});

test("an answered question remains attached to its loaded item", async () => {
  const { daemon, client } = setup();
  daemon.createThread({
    id: "thread-question",
    workspaceId: "ws",
    title: "Question",
    provider: "codex",
  });
  daemon.apply("thread-question", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.tool("root", "ask", { kind: "ask_user", title: "Choose", detail: { kind: "ask_user" } }),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "question",
      item: "ask",
      blocking: false,
      request: {
        kind: "question",
        questions: [
          {
            id: "q",
            text: "Which material?",
            multiSelect: false,
            allowOther: false,
            options: [{ id: "steel", label: "Steel" }],
          },
        ],
      },
    },
  ]);
  await client.start();
  const lease = client.thread("thread-question");
  await act(async () => {});
  const itemId = lease.store.order.find((id) => lease.store.item(id)?.type === "tool_call");
  if (!itemId) throw new Error("Missing question item");
  function Question() {
    const interaction = useItemInteraction("thread-question", itemId ?? "");
    return <output aria-label="question-state">{interaction?.state}</output>;
  }
  render(
    <ClientProvider client={client}>
      <Question />
    </ClientProvider>,
  );
  await screen.findByText("pending");
  await act(async () => {
    daemon.apply("thread-question", [
      {
        type: "interaction.closed",
        interaction: "question",
        state: "resolved",
        resolution: { kind: "question", answers: { q: ["steel"] } },
      },
    ]);
  });
  await screen.findByText("resolved");
  lease.release();
});
