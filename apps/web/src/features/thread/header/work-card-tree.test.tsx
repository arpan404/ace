import { workCardScenario } from "@ace/fake-daemon";
import type { ThreadInit } from "@ace/fake-daemon";
import { DelegatedFrom } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { LayoutProvider } from "@/lib/layout.tsx";
import { componentClient } from "@/test/component-client.tsx";
import { createWorkCardStore, WorkCardContext, type WorkCardStore } from "./work-card-store.ts";
import { WorkCardTreeFollower } from "./work-card-tree.tsx";

function keyValues(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
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
  const show = (...ids: string[]) => {
    const stores = ids.map((id) => {
      const store = createWorkCardStore();
      store.setSide(true);
      return { id, store };
    });
    component.render(
      <QueryClientProvider client={new QueryClient()}>
        <LayoutProvider storage={keyValues()}>
          {stores.map(({ id, store }, index) => (
            <WorkCardContext key={index} value={store}>
              <WorkCardTreeFollower threadId={id} />
            </WorkCardContext>
          ))}
        </LayoutProvider>
      </QueryClientProvider>,
    );
    /** The `nth` screen of `id`, counting from 0. */
    return (id: string, nth = 0): WorkCardStore => {
      const store = stores.filter((each) => each.id === id)[nth]?.store;
      if (!store) throw new Error(`No screen ${nth} of ${id}`);
      return store;
    };
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
  // Opened before the walk up from `e` finished: it still lands on the main thread's tree.
  screen("e").toggle();
  await waitFor(() => expect(screen(main).get().open).toBe(true));
  expect(screen("c").get().open).toBe(true);
  screen(main).setOpen(false);
  expect(screen("e").get().open).toBe(false);
  expect(screen("c").get().open).toBe(false);
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
  // Give the second screen's walk time to settle before asserting it stayed closed.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen("second").get().open).toBe(false);
});

test("a delegate whose parent is on an unpaired machine shares the card with its siblings", async () => {
  const from = DelegatedFrom.parse({ hostId: "host-elsewhere", threadId: "remote-main" });
  const { show } = await threads(() => [
    { id: "here-one", delegatedFrom: from },
    { id: "here-two", delegatedFrom: from },
  ]);
  const screen = show("here-one", "here-two");
  screen("here-one").toggle();
  await waitFor(() => expect(screen("here-two").get().open).toBe(true));
});

test("a resolved chain holds none of its parents' subscriptions", async () => {
  const chain = Array.from({ length: 10 }, (_, index) => `p${index}`);
  const { main, show, client } = await threads((root) =>
    chain.map((id, index) => ({ id, parentThreadId: index === 0 ? root : chain[index - 1] })),
  );
  const room = () => client.threadRoom().getSnapshot();
  const before = room();
  const last = chain.at(-1) ?? "";
  const screen = show(last, main);
  screen(main).toggle();
  await waitFor(() => expect(screen(last).get().open).toBe(true));
  await waitFor(() => expect(room()).toBe(before));
});

test("a delegate opened while offline still shares its card with its other screens", async () => {
  const { show, client } = await threads((root) => [{ id: "b", parentThreadId: root }]);
  await client.close();
  const screen = show("b", "b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  screen("b").toggle();
  // Both screens of `b` find the same tree while its parents can't be read.
  expect(screen("b", 1).get().open).toBe(true);
});
