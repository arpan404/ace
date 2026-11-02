import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";

/** The pencil at the end of the filter row under the Threads title row. */
async function newThreadButton() {
  const panel = await screen.findByRole("complementary", { name: "Threads" });
  return within(panel).findByRole("link", { name: "New thread" });
}

test("on the New thread page the New thread button carries no current mark", async () => {
  const app = harness();
  // One project in the directory, so the button points at New thread there: on bare
  // `/new` the router itself leaves the link quiet, and the button must not mark itself
  // current either. It stays a plain icon button: hover fill only, no current fill.
  createIdleTask(app.daemon, {
    id: "tidy",
    title: "Tidy the README",
    workspaceId: "relay",
    provider: "codex",
  });
  await app.open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  expect((await newThreadButton()).getAttribute("aria-current")).toBeNull();
});
