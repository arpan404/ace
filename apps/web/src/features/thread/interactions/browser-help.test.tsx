import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-cold-start";

beforeEach(() => localStorage.clear());

test.each([
  ["by default", false],
  ["with the browser panel opening for agents' pages", true],
])(
  "an agent's browser help request waits in the composer strip: Open tab shows its tab, Done answers it (%s)",
  async (_name, revealAgentPages) => {
    const history = createMemoryHistory({ initialEntries: ["/settings/general"] });
    const app = harness({ history });
    const scenario = coldStartReplay();
    app.play(scenario).step();
    seedPanels(app.daemon);
    // The agent waits in its own tab while the person looks at another one.
    const login = app.daemon.browser.tabOpen(threadId, "https://example.com/login", {
      label: "login",
    });
    const own = app.daemon.browser.personOpen(threadId, "https://docs.example.com/");
    await app.open("/settings/general");
    const setting = await screen.findByRole("switch", {
      name: "Open the browser panel when an agent opens a page",
    });
    expect(setting.getAttribute("aria-checked")).toBe("false");
    if (revealAgentPages) {
      await userEvent.click(setting);
      await waitFor(() => expect(setting.getAttribute("aria-checked")).toBe("true"));
    }
    act(() => void history.push(`/t/${threadId}`));
    await screen.findByRole("heading", { level: 1, name: scenario.thread.title });

    act(() =>
      app.daemon.apply(threadId, [
        {
          type: "interaction.opened",
          agent: "root",
          interaction: "help",
          blocking: true,
          request: {
            kind: "browser_help",
            tabId: login,
            reason: "login",
            message: "Use your work account",
            url: "https://example.com/login",
            title: "Sign in",
          },
        },
      ]),
    );
    const strip = await screen.findByRole("region", { name: "Waiting for you" });
    expect(
      within(strip).getByRole("heading", { name: "Sign in to example.com in the Browser" }),
    ).toBeTruthy();
    expect(within(strip).getByText("Use your work account")).toBeTruthy();
    expect(app.daemon.browser.view(threadId)?.activeTabId).toBe(own);

    await userEvent.click(within(strip).getByRole("button", { name: "Open tab" }));
    await screen.findByRole("region", { name: "Thread panel" });
    await waitFor(() => expect(app.daemon.browser.view(threadId)?.activeTabId).toBe(login));

    await userEvent.click(within(strip).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(app.daemon.resolution(threadId, "help")).toEqual({
        kind: "browser_help",
        outcome: "done",
      }),
    );
  },
);
