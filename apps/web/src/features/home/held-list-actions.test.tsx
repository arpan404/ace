import { facts, workbench } from "@ace/fake-daemon";
import { ThreadId, type CommandPayload } from "@ace/protocol";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { slowReplay } from "@/test/held-replay.ts";
import { harness } from "@/test/harness.tsx";

/*
 * The thread list after a reconnect's welcome and before its replay lands: connected, but every
 * row still says what was true before the drop. Rows claim no status from it, and a question
 * asked while the list was current but answered after it went stale changes nothing.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const card = (title: RegExp) => within(threads()).getByRole("link", { name: title });

async function openHome() {
  const app = harness();
  const replay = slowReplay(app.daemon);
  const received: CommandPayload[] = [];
  const command = app.daemon.command.bind(app.daemon);
  app.daemon.command = (sent) => {
    received.push(sent.payload);
    return command(sent);
  };
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  const of = (type: CommandPayload["type"]) => received.filter((payload) => payload.type === type);
  const listed = (id: string) => {
    const view = app.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? view.threads[id] : undefined;
  };
  return { app, replay, of, listed };
}

async function menu(title: RegExp, item: string) {
  await userEvent.pointer({ keys: "[MouseRight]", target: card(title) });
  const actions = await screen.findByRole("menu", { name: /^Actions for/ });
  await userEvent.click(within(actions).getByRole("menuitem", { name: item }));
}

test("connected again but not caught up: rows claim no status from the old list", async () => {
  const { app, replay } = await openHome();
  expect(card(/^Backpressure on broadcast fan-out\. Done/)).toBeTruthy();
  expect(card(/^Rewrite the install page for the daemon\. Working/)).toBeTruthy();

  await replay.hold(app.client);
  await waitFor(() =>
    expect(
      within(threads()).queryByRole("link", { name: /^Backpressure on broadcast fan-out\. Done/ }),
    ).toBeNull(),
  );
  expect(
    within(threads()).queryByRole("link", { name: /^Rewrite the install page[^,]*\. Working/ }),
  ).toBeNull();

  replay.release(app.client);
  expect(
    await within(threads()).findByRole("link", {
      name: /^Backpressure on broadcast fan-out\. Done/,
    }),
  ).toBeTruthy();
});

test("Archive, keep running asked while current and confirmed after the list went stale archives nothing", async () => {
  const { app, replay, of, listed } = await openHome();
  await menu(/^Rewrite the install page/, "Archive");
  const ask = await screen.findByRole("dialog", { name: "Archive a running thread?" });

  await replay.hold(app.client);
  await userEvent.click(within(ask).getByRole("button", { name: "Archive, keep running" }));
  expect((await screen.findAllByText("Couldn't archive the thread")).length).toBeGreaterThan(0);
  replay.release(app.client);
  await waitFor(() => expect(card(/^Rewrite the install page/)).toBeTruthy());
  expect(of("thread.archive")).toEqual([]);
  expect(listed("thread-install-page")?.archivedAt).toBeUndefined();
});

test("a bulk Archive asked while current and confirmed after the list went stale archives nothing", async () => {
  const { app, replay, of, listed } = await openHome();
  for (const title of [/^Backpressure on broadcast/, /^Invoice PDF/]) {
    const user = userEvent.setup();
    await user.keyboard("{Meta>}");
    await user.click(card(title));
    await user.keyboard("{/Meta}");
  }
  const selected = await screen.findByRole("toolbar", { name: "Selected threads" });
  await userEvent.click(await within(selected).findByRole("button", { name: "Archive 2 threads" }));
  const ask = await screen.findByRole("dialog", { name: "Archive 2 threads?" });

  await replay.hold(app.client);
  await userEvent.click(within(ask).getByRole("button", { name: "Archive" }));
  replay.release(app.client);
  await waitFor(() => expect(card(/^Invoice PDF/)).toBeTruthy());
  expect(of("thread.archive")).toEqual([]);
  expect(listed("thread-fan-out")?.archivedAt).toBeUndefined();
  expect(listed("thread-pdf-locale")?.archivedAt).toBeUndefined();
});

test("Stop and delete asked while current and confirmed after the list went stale stops and deletes nothing", async () => {
  const { app, replay, of } = await openHome();
  await menu(/^Rewrite the install page/, "Delete thread");
  const ask = await screen.findByRole("dialog", { name: "Delete thread?" });
  const stopAndDelete = within(ask).getByRole("button", { name: "Stop and delete" });

  await replay.hold(app.client);
  await userEvent.click(stopAndDelete);
  replay.release(app.client);
  await waitFor(() => expect(card(/^Rewrite the install page/)).toBeTruthy());
  expect(of("thread.delete")).toEqual([]);
  expect(of("thread.interrupt")).toEqual([]);
  expect(
    app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-install-page") }),
  ).toBeDefined();
});

/** Newer work starts on the install page's thread from another device: a new root run. */
function newerWork(app: Awaited<ReturnType<typeof openHome>>["app"]) {
  act(() =>
    app.daemon.apply("thread-install-page", [
      facts.endTurn("root"),
      { type: "turn.started", agent: "root", nativeTurnId: "elsewhere", trigger: "user" },
    ]),
  );
}

test("a Stop and delete replayed from the outbox after newer work started is refused, and says so", async () => {
  const { app, replay } = await openHome();
  await menu(/^Rewrite the install page/, "Delete thread");
  const ask = await screen.findByRole("dialog", { name: "Delete thread?" });
  // Confirmed while current; the command is lost on the way and waits in the outbox.
  replay.loseCommands();
  await userEvent.click(within(ask).getByRole("button", { name: "Stop and delete" }));
  newerWork(app);
  replay.deliverCommands(app.client);
  expect((await screen.findAllByText(/changed since you looked/)).length).toBeGreaterThan(0);
  expect(
    app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-install-page") }),
  ).toBeDefined();
});

test("an Archive replayed from the outbox after newer work started is refused, and says so", async () => {
  const { app, replay, listed } = await openHome();
  await menu(/^Rewrite the install page/, "Archive");
  const ask = await screen.findByRole("dialog", { name: "Archive a running thread?" });
  replay.loseCommands();
  await userEvent.click(within(ask).getByRole("button", { name: "Archive, keep running" }));
  newerWork(app);
  replay.deliverCommands(app.client);
  expect((await screen.findAllByText(/changed since you looked/)).length).toBeGreaterThan(0);
  expect(listed("thread-install-page")?.archivedAt).toBeUndefined();
});
