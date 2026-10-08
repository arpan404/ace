import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

type Facts = Parameters<FakeDaemon["apply"]>[1];

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const list = () => {
  const viewport = threads().querySelector("[data-virtual-viewport]");
  if (!(viewport instanceof HTMLElement)) throw new Error("no list");
  return viewport;
};
const names = ["Oldest", "Middle", "Newest"];
/** The three threads' rows, top to bottom. */
const order = () =>
  within(threads())
    .getAllByRole("link")
    .map((link) => names.find((name) => link.textContent?.includes(name)));
const row = (name: RegExp) => within(threads()).queryByRole("link", { name });

const working: Facts = [facts.rootAgent("codex"), facts.turn("root")];
const asks: Facts = [
  ...working,
  facts.tool("root", "tests-call", {
    kind: "shell",
    title: "Run the tests",
    status: "awaiting_approval",
    detail: { kind: "shell", command: "bun run test" },
  }),
  {
    type: "interaction.opened",
    agent: "root",
    interaction: "tests",
    blocking: true,
    item: "tests-call",
    request: {
      kind: "approval",
      title: "Run the tests",
      description: "",
      options: [
        { id: "allow", label: "Approve", kind: "allow_once" },
        { id: "deny", label: "Deny", kind: "deny" },
      ],
    },
  },
];

/** One project with three new threads, newest first. */
async function openHome() {
  const app = harness();
  for (const name of names)
    app.daemon.createThread({
      id: `thread-${name.toLowerCase()}`,
      workspaceId: "hold",
      title: `${name} thread`,
      provider: "codex",
    });
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  expect(order()).toEqual(["Newest", "Middle", "Oldest"]);
  return app;
}

test("rows keep their places while the pointer is on the list and move 600 ms after it leaves", async () => {
  const app = await openHome();
  await userEvent.hover(list());
  app.daemon.apply("thread-oldest", working);
  // The row says what changed, in place.
  await waitFor(() => expect(row(/^Oldest thread\. Working/)).toBeTruthy());
  expect(order()).toEqual(["Newest", "Middle", "Oldest"]);

  await userEvent.unhover(list());
  expect(order()).toEqual(["Newest", "Middle", "Oldest"]);
  await waitFor(() => expect(order()).toEqual(["Oldest", "Newest", "Middle"]));
});

test("a thread that needs you waits for the pointer to leave before it rises", async () => {
  const app = await openHome();
  await userEvent.hover(list());
  app.daemon.apply("thread-middle", asks);
  await waitFor(() => expect(row(/^Middle thread\. Waiting for your approval/)).toBeTruthy());
  expect(order()).toEqual(["Newest", "Middle", "Oldest"]);

  // Off the list it rises at once, ahead of the 600 ms the other rows wait.
  await userEvent.unhover(list());
  expect(order()).toEqual(["Middle", "Newest", "Oldest"]);
});

test("while the keyboard is in the list only a thread that needs you moves", async () => {
  const app = await openHome();
  const newest = row(/^Newest thread/);
  if (!newest) throw new Error("no row");
  newest.focus();
  await userEvent.tab();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Settle Newest thread");

  app.daemon.apply("thread-oldest", working);
  app.daemon.apply("thread-middle", asks);
  await waitFor(() => expect(order()).toEqual(["Middle", "Newest", "Oldest"]));
  expect(row(/^Oldest thread\. Working/)).toBeTruthy();

  // Keyboard focus leaving the list lets the rest move.
  const focused = document.activeElement;
  if (focused instanceof HTMLElement) focused.blur();
  await waitFor(() => expect(order()).toEqual(["Middle", "Oldest", "Newest"]));
});
