import { Client } from "@ace/client";
import {
  accountLimit,
  FakeDaemon,
  ScenarioPlayer,
  facts,
  fakeTransport,
  flakyCheckout,
  type Scenario,
} from "@ace/fake-daemon";
import { DeviceId, InteractionId, type ThreadListEntry } from "@ace/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  ClientProvider,
  useAgentTree,
  useInteractions,
  useItem,
  useSidebarIndex,
  type AgentTreeNode,
} from "./index.ts";

const clients: Client[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(clients.splice(0).map((client) => client.close()));
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

test("an index over the thread list re-reads only the threads a change names", async () => {
  const { daemon, client } = setup();
  new ScenarioPlayer(daemon, accountLimit("thread-a", "A")).runThrough("limited");
  const b = new ScenarioPlayer(daemon, accountLimit("thread-b", "B"));
  b.step();
  await client.start();
  const picked: string[] = [];
  const limited = (entry: ThreadListEntry) => {
    picked.push(entry.id);
    return entry.status.state === "limited" ? entry.id : undefined;
  };
  function Limited() {
    const ids = useSidebarIndex(limited);
    return <output aria-label="limited">{(ids ?? []).join(",")}</output>;
  }
  render(
    <ClientProvider client={client}>
      <Limited />
    </ClientProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText("limited").textContent).toBe("thread-a"));

  picked.length = 0;
  await act(async () => b.step());
  await waitFor(() =>
    expect(screen.getByLabelText("limited").textContent).toBe("thread-a,thread-b"),
  );
  // Thread A didn't change, so it wasn't read again.
  expect(new Set(picked)).toEqual(new Set(["thread-b"]));
});
