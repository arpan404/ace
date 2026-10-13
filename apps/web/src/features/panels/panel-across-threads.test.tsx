import { coldStartReplay, failingSubagent } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** Two threads in the sidebar, the first one open. */
async function twoThreads() {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  app.play(failingSubagent()).step();
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  return app;
}

async function switchTo(title: RegExp) {
  const threads = await screen.findByRole("navigation", { name: "Threads" });
  await userEvent.click(within(threads).getByRole("link", { name: title }));
  await screen.findByRole("heading", { level: 1, name: title });
}

test("the side panel stays open on the same tool when another thread opens", async () => {
  await twoThreads();
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(await within(panel).findByRole("tab", { name: /^Changes/ }));

  await switchTo(/Migrate settings schema/);
  const next = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(next).findByRole("tab", { name: /^Changes/, selected: true })).toBeTruthy();
});

test("a side panel hidden in one thread stays hidden in the next", async () => {
  await twoThreads();
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(screen.getAllByRole("button", { name: "Right panel" })[0] as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());

  await switchTo(/Migrate settings schema/);
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();
});
