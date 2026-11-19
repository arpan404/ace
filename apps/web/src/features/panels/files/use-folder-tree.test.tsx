import { ClientProvider } from "@ace/client-react";
import { coldStartReplay } from "@ace/fake-daemon";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";
import { useFolderTree } from "./use-folder-tree.ts";

const thread = "thread-cold-start";

/** A tree with no chrome: its rows as text, and a way to open and fold folders. */
function Probe(props: { threadId: string; initial: string[] }) {
  const [expanded, setExpanded] = useState(props.initial);
  const [paused, setPaused] = useState(false);
  const tree = useFolderTree({
    threadId: props.threadId,
    expanded: new Set(expanded),
    paused,
  });
  const toggle = (folder: string) =>
    setExpanded((folders) =>
      folders.includes(folder) ? folders.filter((each) => each !== folder) : [...folders, folder],
    );
  return (
    <div>
      <button type="button" onClick={() => toggle("apps/")}>
        toggle apps
      </button>
      <button type="button" onClick={() => setPaused((each) => !each)}>
        pause
      </button>
      <div data-part="rows">{tree.rows.map((row) => `${row.kind}:${row.key}`).join("|")}</div>
    </div>
  );
}

async function setup() {
  const app = harness();
  const folders = folderFixture(app.client, thread);
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.client.start();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  return { app, folders };
}

const rowsOf = () => screen.getAllByText(/folder:apps\//);
const same = (a: readonly string[], b: readonly string[]) => a.join("\0") === b.join("\0");

test("two trees on one thread both follow a changed folder, on one watch set", async () => {
  const { app, folders } = await setup();
  const view = render(
    <ClientProvider client={app.client}>
      <Probe threadId={thread} initial={["apps/"]} />
      <Probe threadId={thread} initial={["apps/"]} />
    </ClientProvider>,
  );
  await waitFor(() => expect(rowsOf()).toHaveLength(2));
  await waitFor(() => expect(folders.count("apps")).toBe(2));
  // Both trees watch the same folders: the thread sends one set, once.
  await waitFor(() => expect(folders.watches.at(-1)).toEqual(["", "apps"]));
  expect(folders.watches.filter((each) => same(each, ["", "apps"]))).toHaveLength(1);

  folders.changed(["apps"]);
  await waitFor(() => expect(folders.count("apps")).toBe(4));
  await waitFor(() => expect(rowsOf()).toHaveLength(2));

  view.unmount();
  await waitFor(() => expect(folders.watches.at(-1)).toEqual([]), { timeout: 2_000 });
  expect(folders.watches.filter((each) => each.length === 0)).toHaveLength(1);
});

test("a reply for a stopped request does not replace the newer one", async () => {
  const { app, folders } = await setup();
  render(
    <ClientProvider client={app.client}>
      <Probe threadId={thread} initial={[]} />
    </ClientProvider>,
  );
  const release = folders.hold("apps");
  // The held listing sees the folder before `later/` existed; a newer listing sees it.
  await userEvent.click(screen.getByRole("button", { name: "toggle apps" }));
  app.daemon.checkouts.seed(thread, "apps/later/file.ts", "x\n");
  await userEvent.click(screen.getByRole("button", { name: "toggle apps" }));
  await userEvent.click(screen.getByRole("button", { name: "toggle apps" }));
  await waitFor(() => expect(screen.getByText(/folder:apps\/later\//)).toBeTruthy());
  expect(folders.count("apps")).toBe(2);

  release();
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(screen.queryByText(/folder:apps\/later\//)).toBeTruthy();
  expect(folders.count("apps")).toBe(2);
});

test("a change during a re-list waits for it and lists once more, not in a loop", async () => {
  const { app, folders } = await setup();
  render(
    <ClientProvider client={app.client}>
      <Probe threadId={thread} initial={["apps/"]} />
    </ClientProvider>,
  );
  await waitFor(() => expect(folders.count("apps")).toBe(1));
  // A message naming the folder twice is still one re-list.
  folders.changed(["apps", "apps"]);
  await waitFor(() => expect(folders.count("apps")).toBe(2));

  const release = folders.hold("apps");
  folders.changed(["apps"]);
  await waitFor(() => expect(folders.count("apps")).toBe(3));
  folders.changed(["apps"]);
  folders.changed(["apps"]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(folders.count("apps")).toBe(3);

  release();
  await waitFor(() => expect(folders.count("apps")).toBe(4));
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(folders.count("apps")).toBe(4);
});

test("a reconnect sends the watch set again and lists open folders again", async () => {
  const { app, folders } = await setup();
  render(
    <ClientProvider client={app.client}>
      <Probe threadId={thread} initial={["apps/"]} />
    </ClientProvider>,
  );
  await waitFor(() => expect(folders.count("apps")).toBe(1));
  await waitFor(() => expect(folders.watches.at(-1)).toEqual(["", "apps"]));
  const watches = folders.watches.filter((each) => same(each, ["", "apps"])).length;

  act(() => app.daemon.disconnectAll());
  act(() => app.client.reconnectNow());
  await waitFor(() => expect(app.client.state).toBe("ready"));
  await waitFor(() => expect(folders.count("apps")).toBe(2));
  await waitFor(() =>
    expect(folders.watches.filter((each) => same(each, ["", "apps"])).length).toBe(watches + 1),
  );
});

test("pausing a loading folder stops its request and drops the Loading row", async () => {
  const { app, folders } = await setup();
  const release = folders.hold("apps");
  render(
    <ClientProvider client={app.client}>
      <Probe threadId={thread} initial={["apps/"]} />
    </ClientProvider>,
  );
  await waitFor(() => expect(screen.getByText(/loading:loading:apps\//)).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: "pause" }));
  await waitFor(() => expect(screen.queryByText(/loading:loading:apps\//)).toBeNull());
  release();
});

test("a folder with no rows yet shows Loading, then its entries", async () => {
  const { app, folders } = await setup();
  const release = folders.hold("apps");
  render(
    <ClientProvider client={app.client}>
      <Probe threadId={thread} initial={["apps/"]} />
    </ClientProvider>,
  );
  await waitFor(() => expect(screen.getByText(/loading:loading:apps\//)).toBeTruthy());
  release();
  await waitFor(() => expect(rowsOf()).toHaveLength(1));
  expect(screen.queryByText(/loading:loading:apps\//)).toBeNull();
});

test("under StrictMode's remount the tree still lists the root and opened folders", async () => {
  const { app } = await setup();
  render(
    <StrictMode>
      <ClientProvider client={app.client}>
        <Probe threadId={thread} initial={["apps/"]} />
      </ClientProvider>
    </StrictMode>,
  );
  await waitFor(() => expect(rowsOf()).toHaveLength(1));
  expect(screen.queryByText(/loading:/)).toBeNull();
});
