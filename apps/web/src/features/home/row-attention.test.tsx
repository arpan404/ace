import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("read work stays quiet while unread results, requests and failures retain attention", async () => {
  const app = harness();
  const scenarios = workbench();
  for (const scenario of scenarios) app.play(scenario).runUntilBlocked();
  await app.open("/new");
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  await userEvent.click(await screen.findByRole("button", { name: "Settled 1" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Unsettle Bump Codex app-server to 0.48" }),
  );
  const card = (title: string) => list.getByRole("link", { name: new RegExp(`^${title}`) });
  const attention = (title: string) =>
    card(title).closest("[data-attention]")?.getAttribute("data-attention");
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
    expect(attention(working)).toBe("quiet");
    expect(attention(done)).toBe("quiet");
  });
  expect(within(card(done)).getByText(done).classList.contains("text-subtle-foreground")).toBe(
    true,
  );
  await read(done, true);
  await waitFor(() => expect(attention(done)).toBe("attention"));
  expect(within(card(done)).getByText(done).classList.contains("font-semibold")).toBe(true);
  for (const title of [
    "Partial refunds double-count tax",
    "Approval sheet loses its state on rotate",
    "Invoice PDF locale fallback",
  ]) {
    await read(title, false);
    await waitFor(() => expect(attention(title)).toBe("attention"));
  }
  await read(done, false);
  await userEvent.click(card(done));
  await waitFor(() => expect(card(done).getAttribute("aria-current")).toBe("page"));
  expect(within(card(done)).getByText(done).classList.contains("text-foreground")).toBe(true);
  expect(attention(done)).toBe("quiet");
  await userEvent.click(
    screen.getByRole("button", { name: "Settle Bump Codex app-server to 0.48" }),
  );
  await screen.findByRole("button", { name: "Settled 1" });
  await waitFor(() => expect(attention("Bump Codex app-server to 0.48")).toBe("quiet"));
});
