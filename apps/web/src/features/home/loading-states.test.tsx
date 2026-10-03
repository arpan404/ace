import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("Home shows placeholder cards until the thread list arrives, never a false empty state", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  const threads = await screen.findByRole("navigation", { name: "Threads" });
  expect(within(threads).queryByText("No threads yet")).toBeNull();
  await within(threads).findAllByRole("link");
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading threads" })).toBeNull());
});

test("a daemon with no threads says so once its list has arrived", async () => {
  await harness().open("/");
  const threads = await screen.findByRole("navigation", { name: "Threads" });
  expect(await within(threads).findByText("No threads yet")).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Loading threads" })).toBeNull();
});
