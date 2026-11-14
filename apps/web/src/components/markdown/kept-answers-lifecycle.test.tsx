import { readFileSync } from "node:fs";
import type { ClientApi } from "@ace/client";
import { FakeDaemon } from "@ace/fake-daemon";
import { markitWasmFile } from "@ace/markit-web/assets";
import { preloadMarkit } from "@ace/markit-web/react";
import { ThreadId } from "@ace/protocol";
import { BrowserIcon } from "@phosphor-icons/react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { beforeAll, expect, it } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import { workspaceActions } from "@/lib/workspace/actions.ts";
import {
  allTabs,
  defineTabKind,
  defineWorkspace,
  fileTabId,
  tabKey,
  WorkspaceStore,
} from "@/lib/workspace/index.ts";
import {
  answerContext,
  createKeptAnswer,
  keptAnswersFor,
  sweepKeptAnswers,
} from "./kept-answers.ts";
import { MarkitView, type MarkitCallbacks } from "./markit-view.tsx";
import { useFileLinks } from "./use-file-links.ts";

/*
 * Kept answers live and die with the client that drew them: each client sees only its own,
 * a deleted thread or a closed client takes its answers with it, and a restored answer finishes
 * the work it was doing when its row left (its file links).
 */
beforeAll(() => {
  // jsdom has no Worker: markit runs its Wasm in-process, given the bytes.
  preloadMarkit({ worker: "inline", wasm: readFileSync(markitWasmFile()) });
});

const context = (text: string) =>
  answerContext({ flavor: "agent", scheme: "light", cwd: undefined, root: undefined, text });
const rawText = (container: HTMLElement) => container.querySelector("p.whitespace-pre-wrap");

async function drawn(container: HTMLElement) {
  for (
    let tries = 0;
    tries < 200 && (rawText(container) || !container.querySelector(".markit")?.firstChild);
    tries++
  )
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(rawText(container)).toBeNull();
}

const quiet: MarkitCallbacks = {
  onLink: () => {},
  onSystemLink: () => {},
  onReference: () => {},
  resolveImage: async () => null,
};

/** A client with `threads` open (leased, so it holds them), on a daemon of its own. */
async function clientWith(...threads: string[]) {
  const daemon = new FakeDaemon({ clock: () => Date.parse("2026-11-14T00:00:00Z") });
  for (const id of threads)
    daemon.createThread({ id, workspaceId: "relay", title: id, provider: "codex" });
  const client = fakeClient(daemon);
  await client.start();
  const leases = threads.map((id) => client.thread(id));
  for (const lease of leases) await waitFor(() => expect(lease.store.thread).toBeDefined());
  return { client, leases };
}

function answerView(props: {
  client: ClientApi;
  text: string;
  threadId: string;
  itemId: string;
  streaming?: boolean;
  callbacks?: MarkitCallbacks;
}) {
  return (
    <MarkitView
      markdown={props.text}
      finalized={!props.streaming}
      stream={`${props.threadId}/${props.itemId}`}
      callbacks={props.callbacks ?? quiet}
      flavor="agent"
      keep={{
        answers: keptAnswersFor(props.client),
        scope: { threadId: props.threadId, itemId: props.itemId },
        cwd: undefined,
        root: undefined,
      }}
    />
  );
}

it("two clients whose threads and items share ids each get back only their own drawing", async () => {
  const one = await clientWith("thread-same");
  const two = await clientWith("thread-same");
  const text = "Deleted **14** merged branches.";
  const scope = { text, threadId: "thread-same", itemId: "item-1" };
  const first = render(answerView({ client: one.client, ...scope }));
  await drawn(first.container);
  first.unmount();

  const other = render(answerView({ client: two.client, ...scope }));
  expect(rawText(other.container)?.textContent).toBe(text);
  other.unmount();
  const own = render(answerView({ client: one.client, ...scope }));
  expect(rawText(own.container)).toBeNull();
  expect(own.container.querySelector("strong")?.textContent).toBe("14");
});

it("a deleted thread's answers go, and a closed client's go with it", async () => {
  const { client, leases } = await clientWith("thread-gone", "thread-kept");
  const kept = keptAnswersFor(client);
  for (const threadId of ["thread-gone", "thread-kept"]) {
    const answer = createKeptAnswer({ worker: "inline", flavor: "agent" }, {});
    await answer.renderer.render("Pruned **3** remotes.");
    kept.keep({ threadId, itemId: "i" }, context(threadId), answer, 40);
  }
  expect(kept.size).toBe(2);

  await client.command({ type: "thread.delete", threadId: ThreadId.parse("thread-gone") });
  await waitFor(() => expect(leases[0]?.store.thread?.deletedAt).toBeDefined());
  sweepKeptAnswers();
  expect(kept.has({ threadId: "thread-gone", itemId: "i" }, context("thread-gone"))).toBe(false);
  expect(kept.size).toBe(1);

  for (const lease of leases) lease.release();
  await client.close();
  sweepKeptAnswers();
  expect(kept.records).toBe(0);
});

it("a cache emptied while a finished answer is still on screen is swept once that answer is kept", async () => {
  const { client, leases } = await clientWith("thread-busy");
  const kept = keptAnswersFor(client);
  const busy = { client, threadId: "thread-busy" };
  const unfinished = render(
    answerView({ ...busy, itemId: "a", text: "Still **writing**", streaming: true }),
  );
  const finished = render(answerView({ ...busy, itemId: "b", text: "Done **now**." }));
  await drawn(unfinished.container);
  await drawn(finished.container);
  // The unfinished answer leaves first, with nothing kept: the cache holds no record then.
  unfinished.unmount();
  expect(kept.records).toBe(0);
  finished.unmount();
  expect(kept.size).toBe(1);

  await client.command({ type: "thread.delete", threadId: ThreadId.parse("thread-busy") });
  await waitFor(() => expect(leases[0]?.store.thread?.deletedAt).toBeDefined());
  sweepKeptAnswers();
  expect(kept.records).toBe(0);
});

/** A Files kind, so a file mention has a tab to open in. */
const workspace = defineWorkspace({
  label: "Thread panel",
  launcher: "new-tab",
  initial: [],
  kinds: async () => ({
    default: [
      defineTabKind({
        kind: "files",
        label: "Files",
        icon: BrowserIcon,
        load: async () => ({ default: () => null }),
      }),
      defineTabKind({
        kind: "new-tab",
        label: "New tab",
        icon: BrowserIcon,
        load: async () => ({ default: () => null }),
      }),
    ],
  }),
});

function LinkedAnswer(props: { client: ClientApi; store: WorkspaceStore; text: string }) {
  const { client, store } = props;
  const scope = useMemo(
    () => ({ actions: workspaceActions(store, "thread"), read: () => store.get("thread") }),
    [store],
  );
  const links = useFileLinks({
    client,
    threadId: "relay-thread",
    itemId: "answer",
    root: undefined,
    workspace: scope,
  });
  const callbacks: MarkitCallbacks = {
    ...quiet,
    onReference: (reference) => {
      if (reference.kind === "file") links.open(reference.target);
    },
    drawn: links.drawn,
  };
  return answerView({
    client,
    text: props.text,
    threadId: "relay-thread",
    itemId: "answer",
    callbacks,
  });
}

it("a file mention whose lookup was cut short when its row left is linked once it comes back", async () => {
  await workspace.load();
  const { client } = await clientWith("relay-thread");
  // Lookups wait until the test lets them through.
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  const lookups: string[] = [];
  const request = client.request.bind(client);
  client.request = (async (message, options) => {
    if (message.type === "context.request" && message.operation.op === "mention.complete") {
      lookups.push(message.operation.query);
      // As a real request does, an abandoned lookup stops waiting at once.
      const signal = options?.signal;
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return request(message, options);
  }) as typeof client.request;
  const store = new WorkspaceStore({ storage: { getItem: () => null, setItem: () => {} } });
  store.define("thread", workspace);
  const path = "apps/web/src/relay/outbox.ts";
  const text = `The fix is in \`${path}\`.`;

  const first = render(<LinkedAnswer client={client} store={store} text={text} />);
  await drawn(first.container);
  await waitFor(() => expect(lookups).toHaveLength(1));
  // The row leaves mid-lookup: that lookup is abandoned.
  first.unmount();

  const again = render(<LinkedAnswer client={client} store={store} text={text} />);
  expect(rawText(again.container)).toBeNull();
  await waitFor(() => expect(lookups).toHaveLength(2));
  open();
  const link = await waitFor(() => {
    const found = again.container.querySelector('code[role="link"]');
    if (!found) throw new Error("not linked yet");
    return found;
  });
  fireEvent.click(link);
  await waitFor(() =>
    expect(allTabs(store.get("thread")).map((tab) => tab.key)).toContain(
      tabKey("files", fileTabId(path)),
    ),
  );
});
