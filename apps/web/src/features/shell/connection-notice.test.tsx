import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const offline = /^Offline/;

async function openHome() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

test("offline, the inline notice counts and lists waiting actions and offers Retry", async () => {
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
  const waiting = screen.getByRole("list", { name: "Waiting for ace" });
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

test("offline, the project's Add action explains why it is unavailable and works after reconnect", async () => {
  const app = await openHome();
  app.client.networkOnline(false);
  await screen.findByText(offline);
  await userEvent.click(screen.getByRole("button", { name: /^Project filter:/ }));
  const add = await screen.findByRole("menuitem", { name: /^Add project/ });
  expect(add.getAttribute("aria-disabled")).toBe("true");
  expect(within(add).getByText("Connect to this computer to add a project.")).toBeTruthy();
  await userEvent.click(add);
  expect(screen.queryByRole("dialog")).toBeNull();

  app.client.networkOnline(true);
  await waitFor(() => expect(add.getAttribute("aria-disabled")).not.toBe("true"));
  await userEvent.click(add);
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
}, 15_000);
