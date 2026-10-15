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

test("another thread starts with its panel hidden and keeps its own selected tool", async () => {
  await twoThreads();
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(await within(panel).findByRole("tab", { name: /^Changes/ }));

  await switchTo(/Migrate settings schema/);
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const next = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(next).findByRole("tab", { name: /^Summary/, selected: true })).toBeTruthy();

  await switchTo(/Cap cold-start replay/);
  const restored = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    await within(restored).findByRole("tab", { name: /^Changes/, selected: true }),
  ).toBeTruthy();
});

test("returning to a thread restores its open panel even when the previous thread's is hidden", async () => {
  await twoThreads();
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(await within(panel).findByRole("tab", { name: /^Changes/ }));

  await switchTo(/Migrate settings schema/);
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();
  await switchTo(/Cap cold-start replay/);
  const restored = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    await within(restored).findByRole("tab", { name: /^Changes/, selected: true }),
  ).toBeTruthy();
});

test("a side panel hidden in a thread stays hidden when returning from an open panel", async () => {
  await twoThreads();
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(screen.getAllByRole("button", { name: "Right panel" })[0] as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());

  await switchTo(/Migrate settings schema/);
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  await screen.findByRole("region", { name: "Thread panel" });
  await switchTo(/Cap cold-start replay/);
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();
});

test("creating a new thread leaves its panel hidden after leaving a thread with an open panel", async () => {
  await twoThreads();
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  await screen.findByRole("region", { name: "Thread panel" });

  await userEvent.keyboard("{Meta>}n{/Meta}");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
  await userEvent.click(await screen.findByRole("option", { name: "ace" }));
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Keep this conversation focused{Enter}",
  );
  await screen.findByRole("heading", { level: 1, name: "Keep this conversation focused" });
  await screen.findByRole("button", { name: "Right panel" });
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();
});
