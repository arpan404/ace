import { workCardScenario } from "@ace/fake-daemon";
import type { ThreadInit } from "@ace/fake-daemon";
import { DelegatedFrom } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { expect, test } from "vitest";
import { LayoutProvider } from "@/lib/layout.tsx";
import { componentClient } from "@/test/component-client.tsx";
import type { WorkCardStore } from "./work-card-store.ts";
import { useWorkCard, useWorkCardSide } from "./work-card-tree.tsx";

function keyValues(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function Wide(props: { children: React.ReactNode }) {
  useWorkCardSide().current = true;
  return props.children;
}

function Screen(props: {
  threadId: string;
  onMount(store: WorkCardStore, firstRenderOpen: boolean): void;
}) {
  const store = useWorkCard(props.threadId);
  const mounted = useRef(false);
  if (!mounted.current) {
    mounted.current = true;
    props.onMount(store, store.get().open);
  }
  return null;
}

/**
 * A main thread (the fixture's) and the threads `more` adds, then screens of the given threads,
 * each with room to dock its card.
 */
async function threads(more: (main: string) => Partial<ThreadInit>[]) {
  const fixture = workCardScenario("changes");
  const component = await componentClient(fixture);
  const main = fixture.thread.id;
  for (const init of more(main)) {
    const id = init.id ?? "";
    component.daemon.createThread({
      workspaceId: fixture.thread.workspaceId,
      title: id,
      provider: "codex",
      ...init,
      id,
    });
  }
  const show = (...initialIds: string[]) => {
    const records: { id: string; store: WorkCardStore; firstRenderOpen: boolean }[] = [];
    let addIds: ((moreIds: string[]) => void) | undefined;
    function Host() {
      const [ids, setIds] = useState(initialIds);
      addIds = (moreIds) => setIds((prev) => [...prev, ...moreIds]);
      return (
        <Wide>
          {ids.map((id, index) => (
            <Screen
              key={`${index}-${id}`}
              threadId={id}
              onMount={(store, firstRenderOpen) => {
                records.push({ id, store, firstRenderOpen });
              }}
            />
          ))}
        </Wide>
      );
    }
    component.render(
      <QueryClientProvider client={new QueryClient()}>
        <LayoutProvider storage={keyValues()}>
          <Host />
        </LayoutProvider>
      </QueryClientProvider>,
    );
    const entry = (id: string, nth = 0) => {
      const found = records.filter((each) => each.id === id)[nth];
      if (!found) throw new Error(`No screen ${nth} of ${id}`);
      return found;
    };
    /** The `nth` screen of `id`, counting from 0. */
    const screen = (id: string, nth = 0): WorkCardStore => entry(id, nth).store;
    return Object.assign(screen, {
      firstRenderOpen: (id: string, nth = 0) => entry(id, nth).firstRenderOpen,
      mount: (...moreIds: string[]) => act(() => addIds?.(moreIds)),
    });
  };
  return { main, show, client: component.client };
}

test("a delegate five levels down opens and closes the card with its main thread", async () => {
  const { main, show } = await threads((root) => [
    { id: "b", parentThreadId: root },
    { id: "c", parentThreadId: "b" },
    { id: "d", parentThreadId: "c" },
    { id: "e", parentThreadId: "d" },
  ]);
  const screen = show("e", "c", main);
  // Opened before `e`'s snapshot arrived: it still lands on the main thread's tree.
  screen("e").toggle();
  await waitFor(() => expect(screen(main).get().open).toBe(true));
  expect(screen("c").get().open).toBe(true);
  screen(main).setOpen(false);
  expect(screen("e").get().open).toBe(false);
  expect(screen("c").get().open).toBe(false);
});

test("a thread started with thread_start opens and closes the card with its starter's tree", async () => {
  const { main, show } = await threads((root) => [
    { id: "delegate", parentThreadId: root },
    { id: "started", startedBy: "delegate" },
  ]);
  const screen = show(main, "started");
  screen(main).toggle();
  await waitFor(() => expect(screen("started").get().open).toBe(true));
  screen("started").setOpen(false);
  expect(screen(main).get().open).toBe(false);
});

test("threads Spade delegated each keep their own card", async () => {
  const { show } = await threads(() => [
    { id: "spade-host", host: "spade" },
    { id: "first", parentThreadId: "spade-host" },
    { id: "second", parentThreadId: "spade-host" },
  ]);
  const screen = show("first", "second");
  screen("first").toggle();
  await waitFor(() => expect(screen("first").get().open).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen("second").get().open).toBe(false);
});

test("delegates from a paired machine share the card on the root the delegating machine named", async () => {
  const fromChild = DelegatedFrom.parse({
    hostId: "host-elsewhere",
    threadId: "remote-child",
    rootThreadId: "remote-root",
  });
  const fromRoot = DelegatedFrom.parse({
    hostId: "host-elsewhere",
    threadId: "remote-root",
  });
  const { show } = await threads(() => [
    { id: "here-from-child", delegatedFrom: fromChild },
    { id: "here-from-root", delegatedFrom: fromRoot },
  ]);
  const screen = show("here-from-child", "here-from-root");
  screen("here-from-child").toggle();
  await waitFor(() => expect(screen("here-from-root").get().open).toBe(true));
});

test("opening a deep delegate takes no extra subscriptions for its ancestors", async () => {
  const chain = Array.from({ length: 10 }, (_, index) => `p${index}`);
  const { main, show, client } = await threads((root) =>
    chain.map((id, index) => ({ id, parentThreadId: chain[index - 1] ?? root })),
  );
  const room = () => client.threadRoom().getSnapshot();
  const before = room();
  const last = chain.at(-1) ?? "";
  const screen = show(last, main);
  screen(main).toggle();
  await waitFor(() => expect(screen(last).get().open).toBe(true));
  // Only the two mounted screens (`last` and `main`) hold subscriptions; none of `p0..p8` do.
  expect(room()).toBe(before - 2);
});

test("a cached child screen of an open tree starts open on its very first render", async () => {
  const { main, show, client } = await threads((root) => [{ id: "started", startedBy: root }]);
  // Keep the sidebar warm so the client already knows `started`'s treeRootId before it mounts.
  const sidebarLease = client.threads();
  await waitFor(() => expect(client.cachedThreads?.()?.thread("started")).toBeDefined());
  try {
    const screen = show(main);
    await waitFor(() => expect(client.cachedThread?.(main)?.thread).toBeDefined());
    screen(main).toggle();
    expect(screen(main).get().open).toBe(true);
    screen.mount("started");
    expect(screen.firstRenderOpen("started")).toBe(true);
    expect(screen("started").get().open).toBe(true);
  } finally {
    sidebarLease.release();
  }
});

test("a delegate opened while offline still shares its card with its other screens", async () => {
  const { show, client } = await threads((root) => [{ id: "b", parentThreadId: root }]);
  await client.close();
  const screen = show("b", "b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  screen("b").toggle();
  // Both screens of `b` fall back to `b` while it can't be read.
  expect(screen("b", 1).get().open).toBe(true);
});

test("a card opened offline on a delegate moves to its main thread once it reconnects", async () => {
  const { main, show, client } = await threads((root) => [{ id: "b", parentThreadId: root }]);
  client.networkOnline(false);
  const screen = show("b", main);
  await new Promise((resolve) => setTimeout(resolve, 20));
  screen("b").toggle();
  expect(screen(main).get().open).toBe(false);
  client.networkOnline(true);
  await waitFor(() => expect(screen(main).get().open).toBe(true));
  expect(screen("b").get().open).toBe(true);
});
