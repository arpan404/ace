import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const titles = workbench().map((scenario) => scenario.thread.title);
const order = () =>
  within(threads())
    .queryAllByRole("link")
    .map((link) => titles.find((title) => link.textContent?.includes(title)));
const before = (a: string, b: string) => order().indexOf(a) < order().indexOf(b);
const card = (title: RegExp) => within(threads()).getByRole("link", { name: title });

async function openHome() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

function threadOf(app: ReturnType<typeof harness>, id: string) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

test("a row's details open beside it rather than over the rows below", async () => {
  await openHome();
  await userEvent.hover(card(/^Partial refunds/));
  const details = await screen.findByLabelText(/^Details for Partial refunds/);
  expect(details.closest("[data-side]")?.getAttribute("data-side")).toBe("right");
});

test("Settle and Unsettle on a row's hover actions move it between the list and Settled", async () => {
  const app = await openHome();
  const title = "Bump Codex app-server to 0.48";
  await userEvent.click(await screen.findByRole("button", { name: "Settled (1)" }));
  await userEvent.click(screen.getByRole("button", { name: `Unsettle ${title}` }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Settled / })).toBeNull());
  expect(threadOf(app, "thread-bump-codex")?.settledAt).toBeUndefined();
  expect(order()).toContain(title);

  await userEvent.click(screen.getByRole("button", { name: `Settle ${title}` }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Settled (1)" })).toBeTruthy());
  expect(threadOf(app, "thread-bump-codex")?.settledAt).toBeDefined();
});

test("work still running offers Snooze on hover but no Settle", async () => {
  await openHome();
  const title = "Dedupe thread events after reconnect";
  expect(screen.getByRole("button", { name: `Snooze ${title}` })).toBeTruthy();
  expect(screen.queryByRole("button", { name: `Settle ${title}` })).toBeNull();
});

test("the hover clock snoozes a thread below the others until the time picked", async () => {
  const app = await openHome();
  const title = "Retry budget for app-server restarts";
  const id = workbench().find((scenario) => scenario.thread.title === title)?.thread.id;
  if (!id) throw new Error("Missing scenario");
  await userEvent.click(screen.getByRole("button", { name: `Snooze ${title}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Tomorrow/ }));
  await waitFor(() => expect(card(/^Retry budget.*Snoozed until tomorrow/)).toBeTruthy());
  expect(threadOf(app, id)?.snoozedUntil).toBeDefined();

  const list = threads().querySelector("[data-virtual-viewport]");
  if (!(list instanceof HTMLElement)) throw new Error("no list");
  await userEvent.unhover(list);
  await waitFor(() => expect(before("Backpressure on broadcast fan-out", title)).toBe(true));
});
