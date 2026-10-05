import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const offline = /^Offline · messages, answers and Stop will send when the daemon is back/;

async function openHome() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

test("offline, the notice says what will send, counts what waits and lists it", async () => {
  const app = await openHome();
  app.client.networkOnline(false);
  expect((await screen.findByText(offline)).textContent).not.toContain("waiting");

  // A message and an archive made while offline wait for the daemon.
  void app.client.command({
    type: "thread.send",
    threadId: ThreadId.parse("thread-fan-out"),
    input: [{ type: "text", text: "Retry with **jitter**\nand log it" }],
  });
  const row = within(threads()).getByRole("link", { name: /^Backpressure/ });
  await userEvent.pointer({ keys: "[MouseRight]", target: row });
  const menu = await screen.findByRole("menu", { name: /^Actions for/ });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));

  const notice = await screen.findByRole("button", { name: /· 2 waiting$/ });
  expect(notice.textContent).toMatch(offline);
  await userEvent.click(notice);
  const waiting = screen.getByRole("list", { name: "Waiting for the daemon" });
  expect(
    within(waiting)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Message · Retry with jitter", "Archive · Backpressure on broadcast fan-out"]);

  // Back online, both go out and the notice leaves.
  app.client.networkOnline(true);
  await waitFor(() => expect(screen.queryByText(offline)).toBeNull());
  await waitFor(() => {
    const view = app.daemon.snapshot({ kind: "threads" });
    expect(view?.kind === "threads" && view.threads["thread-fan-out"]?.archivedAt).toBeTruthy();
  });
}, 15_000);

test("offline, Add project is off and says it needs the daemon", async () => {
  const app = await openHome();
  app.client.networkOnline(false);
  await screen.findByText(offline);
  const add = screen.getByRole("button", { name: "Add project" });
  expect(add.getAttribute("aria-disabled")).toBe("true");
  await userEvent.hover(add);
  expect((await screen.findByRole("tooltip")).textContent).toBe("Needs the daemon");
  await userEvent.click(add);
  expect(screen.queryByRole("dialog")).toBeNull();

  // Back online it opens the dialog again.
  app.client.networkOnline(true);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Add project" }).getAttribute("aria-disabled"),
    ).not.toBe("true"),
  );
  await userEvent.click(screen.getByRole("button", { name: "Add project" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
}, 15_000);
