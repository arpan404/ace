import { workbench } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * Instant send (UX audit W2): from Enter on New thread until the started thread opens, the
 * main pane never empties. Every change the page commits is watched; in none of them may the
 * composer be missing, and the message is on screen from the first one on the new route.
 */

let stopWatching: (() => void) | undefined;
afterEach(() => stopWatching?.());

/** Every committed page state from now on: its route and title, its composer and the message. */
function watchPage(text: string, where: () => string) {
  const states: { path: string; page: string; composer: boolean; message: boolean }[] = [];
  const observer = new MutationObserver(() => {
    states.push({
      path: where(),
      page: document.querySelector("header h1")?.textContent ?? "",
      composer: !!document.querySelector('[data-slot="composer"]'),
      message: !!document.querySelector('[role="feed"]')?.textContent?.includes(text),
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  stopWatching = () => observer.disconnect();
  return states;
}

for (const worktree of [false, true]) {
  test(`the composer and the message stay on screen from Enter until the thread opens (${worktree ? "worktree" : "local"})`, async () => {
    const history = createMemoryHistory({ initialEntries: ["/new?project=relay"] });
    const made = harness({ history });
    made.daemon.services.settings.seed({ "threads.useWorktree": worktree });
    for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
    await made.open("/new?project=relay");
    const field = await screen.findByRole("combobox", { name: "Message" });
    await waitFor(() =>
      expect(
        screen.queryByText(/^(Checking provider settings|Preparing attachment storage)…$/),
      ).toBeNull(),
    );
    const checkbox = await screen.findByRole("checkbox", { name: "Worktree" });
    expect(checkbox.getAttribute("aria-checked")).toBe(String(worktree));

    const text = "Trace the reconnect storm";
    await userEvent.type(field, text);
    const states = watchPage(text, () => history.location.pathname);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(history.location.pathname).toMatch(/^\/t\/thread-/), {
      timeout: 8000,
    });
    const feed = await screen.findByRole("feed", { name: "Transcript" });
    await waitFor(() => expect(within(feed).getAllByText(text)).toHaveLength(1));

    expect(states.filter((state) => !state.composer)).toEqual([]);
    // Once New thread gives way (the router may change the path a moment before), the
    // message is there in every state.
    const away = states.filter((state) => state.page !== "New thread");
    expect(away.length).toBeGreaterThan(0);
    expect(away.filter((state) => !state.message)).toEqual([]);
  });
}
