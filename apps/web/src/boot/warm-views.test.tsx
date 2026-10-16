import {
  ClientProvider,
  useThread,
  useThreadMeta,
  useThreadSyncing,
  useSidebarIndex,
  useSidebarLoaded,
} from "@ace/client-react";
import { ClientHost, RemoteClient } from "@ace/client-worker";
import { FakeDaemon, facts } from "@ace/fake-daemon";
import { render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { expect, test, vi } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";

const scheduler = {
  set(ms: number, run: () => void) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
function remoteFor(daemon: FakeDaemon) {
  const core = fakeClient(daemon);
  const host = new ClientHost({
    target: () => ({ key: "isolated", create: () => core }),
    scheduler,
    now: () => 0,
    frameMs: 1,
    lingerMs: 1,
  });
  const { port1, port2 } = new MessageChannel();
  host.attach(port1);
  return { core, remote: new RemoteClient(port2, {}, { scheduler }) };
}

function clientFor(daemon: FakeDaemon, mode: "worker" | "in-process") {
  if (mode === "worker") return remoteFor(daemon);
  const core = fakeClient(daemon);
  return { core, remote: core };
}

test.each(["worker", "in-process"] as const)(
  "a warm %s view paints cached content on its first commit and reconciles missed output",
  async (mode) => {
    const daemon = new FakeDaemon({ clock: () => 1 });
    daemon.createThread({
      id: "warm",
      workspaceId: "ace",
      title: "Warm thread",
      provider: "codex",
    });
    daemon.apply("warm", [
      facts.rootAgent("codex"),
      facts.message("root", "ask", "user", "Original"),
    ]);
    const chosen = clientFor(daemon, mode);
    const remote = chosen.remote;
    const commits: (string | undefined)[] = [];
    function View() {
      const meta = useThreadMeta("warm");
      const syncing = useThreadSyncing("warm");
      const text = useThread("warm", ["order"], (reader) =>
        reader.order
          .map((id) => {
            const item = reader.item(id);
            return item?.type === "message"
              ? item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
              : "";
          })
          .join(" "),
      );
      useLayoutEffect(() => {
        commits.push(meta?.title);
      }, [meta]);
      return (
        <div>
          {meta?.title ?? "Loading"}
          <span>{text}</span>
          <span>{syncing ? "Syncing" : "Live"}</span>
        </div>
      );
    }
    try {
      await remote.start();
      const held = remote.thread("warm");
      await vi.waitFor(() => expect(held.store.thread?.title).toBe("Warm thread"));
      held.release();
      expect(remote.cachedThread("warm")?.syncing).toBe(true);
      daemon.apply("warm", [facts.message("root", "answer", "assistant", "Missed while away")]);
      const mounted = render(
        <ClientProvider client={remote}>
          <View />
        </ClientProvider>,
      );
      expect(commits[0]).toBe("Warm thread");
      expect(screen.queryByText("Loading")).toBeNull();
      await screen.findByText("Original Missed while away");
      await screen.findByText("Live");
      mounted.unmount();
    } finally {
      await remote.close();
      await chosen.core.close();
    }
  },
);

test.each([
  { bound: "bytes", threads: 17, items: 10, text: "x".repeat(60_000) },
  { bound: "count", threads: 35, items: 1, text: "small" },
])(
  "inactive tab mirrors evict old views by $bound while a leased view stays available",
  async ({ threads, items, text }) => {
    const daemon = new FakeDaemon({ clock: () => 1 });
    for (let index = 0; index < threads; index++) {
      const id = `budget-${index}`;
      daemon.createThread({ id, workspaceId: "ace", title: id, provider: "codex" });
      daemon.apply(id, [
        facts.rootAgent("codex"),
        ...Array.from({ length: items }, (_, i) =>
          facts.message("root", `m-${i}`, "assistant", text),
        ),
      ]);
    }
    const { core, remote } = remoteFor(daemon);
    try {
      await remote.start();
      const active = remote.thread("budget-0");
      await waitFor(() => expect(active.store.order).toHaveLength(items));
      for (let index = 1; index < threads; index++) {
        const lease = remote.thread(`budget-${index}`);
        await waitFor(() => expect(lease.store.order).toHaveLength(items));
        lease.release();
      }
      expect(remote.cachedThread("budget-1")).toBeUndefined();
      expect(remote.cachedThread(`budget-${threads - 1}`)?.order).toHaveLength(items);
      expect(remote.cachedThread("budget-0")?.order).toHaveLength(items);
      active.release();
    } finally {
      await remote.close();
      await core.close();
    }
  },
  20_000,
);

const pickTitle = (entry: { title: string }) => entry.title;
test.each(["worker", "in-process"] as const)(
  "a warm %s sidebar paints its indexed rows on the first commit",
  async (mode) => {
    const daemon = new FakeDaemon({ clock: () => 1 });
    daemon.createThread({
      id: "sidebar",
      workspaceId: "ace",
      title: "Cached sidebar row",
      provider: "codex",
    });
    const chosen = clientFor(daemon, mode);
    const remote = chosen.remote;
    const commits: string[] = [];
    function Sidebar() {
      const rows = useSidebarIndex(pickTitle);
      const loaded = useSidebarLoaded();
      const text = loaded && rows ? rows.join(",") : "Loading";
      useLayoutEffect(() => {
        commits.push(text);
      }, [text]);
      return <div>{text}</div>;
    }
    try {
      await remote.start();
      const held = remote.threads();
      await vi.waitFor(() => expect(held.store.loaded).toBe(true));
      held.release();
      const mounted = render(
        <ClientProvider client={remote}>
          <Sidebar />
        </ClientProvider>,
      );
      expect(commits[0]).toBe("Cached sidebar row");
      expect(screen.queryByText("Loading")).toBeNull();
      mounted.unmount();
    } finally {
      await remote.close();
      await chosen.core.close();
    }
  },
);
