import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("completed rows announce unread results and retain full status after marking read", async () => {
  const app = harness();
  const scenarios = workbench();
  for (const scenario of scenarios) app.play(scenario).runUntilBlocked();
  await app.open("/new");
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  await userEvent.click(await screen.findByRole("button", { name: "Settled (1)" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Actions for Bump Codex app-server to 0.48" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Unsettle" }));
  const card = (title: string) => list.getByRole("link", { name: new RegExp(`^${title}`) });
  const read = async (title: string, unread: boolean) => {
    const scenario = scenarios.find((entry) => entry.thread.title === title);
    if (!scenario) throw new Error(`Missing ${title}`);
    await app.client.command({
      type: "thread.read",
      threadId: ThreadId.parse(scenario.thread.id),
      unread,
    });
  };
  const working = "Rewrite the install page for the daemon";
  const done = "Bump Codex app-server to 0.48";
  await read(working, false);
  await read(done, false);
  await waitFor(() => {
    expect(card(working).getAttribute("aria-label")).not.toContain(", unread");
    expect(card(done).getAttribute("aria-label")).not.toContain(", unread");
  });
  expect(card(done).getAttribute("aria-label")).not.toContain(", unread");
  expect(within(card(done)).getByText("Done", { exact: true })).toBeTruthy();
  await read(done, true);
  await waitFor(() => expect(card(done).getAttribute("aria-label")).toContain(", unread"));
  expect(card(done).getAttribute("aria-label")).toContain(", unread");
  for (const title of [
    "Partial refunds double-count tax",
    "Approval sheet loses its state on rotate",
    "Invoice PDF locale fallback",
  ]) {
    await read(title, false);
    await waitFor(() => expect(card(title).getAttribute("aria-label")).not.toContain(", unread"));
    expect(card(title).getAttribute("aria-label")).toMatch(
      /Waiting for your approval|Waiting for your answer|Failed/,
    );
  }
  await read(done, false);
  await userEvent.click(card(done));
  await waitFor(() => expect(card(done).getAttribute("aria-current")).toBe("page"));
  expect(card(done).getAttribute("aria-label")).not.toContain(", unread");
  await userEvent.click(
    screen.getByRole("button", { name: "Actions for Bump Codex app-server to 0.48" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Settle" }));
  // Settled was left open above, so the settled row shows there at once.
  const settled = await screen.findByRole("button", { name: "Settled (1)" });
  expect(settled.getAttribute("aria-expanded")).toBe("true");
  await waitFor(() => expect(card(done).getAttribute("aria-label")).not.toContain(", unread"));
});
