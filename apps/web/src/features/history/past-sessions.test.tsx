import { workbench } from "@ace/fake-daemon";
import { HistorySession } from "@ace/protocol";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

function app() {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  made.daemon.seedServices({
    history: [
      HistorySession.parse({
        id: "saved-claude",
        instanceId: "claude",
        provider: "claude",
        nativeId: "native",
        cwd: "/Users/dev/relay",
        title: "Fix the old retry loop",
        lastActivity: Date.now(),
        messageCount: 3,
        countAccuracy: "exact",
        support: { status: "supported" },
        continuation: { status: "supported" },
      }),
      HistorySession.parse({
        id: "saved-codex",
        instanceId: "codex",
        provider: "codex",
        nativeId: "native-codex",
        cwd: "/Users/dev/relay",
        title: "Trace delivery order",
        lastActivity: Date.now() - 1000,
        messageCount: 3,
        countAccuracy: "exact",
        support: { status: "supported" },
        continuation: {
          status: "unsupported",
          reason: "Install Codex to continue. Import to read the history.",
        },
      }),
    ],
  });
  return made;
}

test("New thread lists the selected project's sessions and Import opens their saved conversation", async () => {
  const made = app();
  await made.open("/new?project=relay");
  const list = await screen.findByRole("list", { name: "Past sessions in relay" });
  expect(await within(list).findByText("Import only")).toBeTruthy();
  await userEvent.click(
    within(list).getAllByRole("button", { name: "Import" })[0] ??
      (() => {
        throw new Error("Missing Import");
      })(),
  );
  await screen.findByRole("heading", { level: 1, name: "Fix the old retry loop" });
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(within(feed).getByText("Fix the old retry loop")).toBeTruthy();
});

test("Continue opens a resumed conversation without sending a made-up message", async () => {
  const made = app();
  await made.open("/new?project=relay");
  const list = await screen.findByRole("list", { name: "Past sessions in relay" });
  const requests: unknown[] = [];
  const stop = made.client.onMessage((message) => {
    if (message.type === "history.continue") requests.push(message);
  });
  await userEvent.click(await within(list).findByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { level: 1, name: "Fix the old retry loop" });
  await waitFor(() =>
    expect(requests).toContainEqual(
      expect.objectContaining({ status: "continued", nativeSessionId: "native" }),
    ),
  );
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(within(feed).queryByText("Continue")).toBeNull();
  stop();
});

test("Setup can be reopened from the palette and filters past sessions by project", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search commands" }), "Setup");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Set up" });
  await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
  const selector = await screen.findByRole("combobox", { name: "Past sessions project" });
  await userEvent.click(selector);
  await userEvent.click(await screen.findByRole("option", { name: "relay" }));
  await screen.findByText("Fix the old retry loop");
  await userEvent.click(selector);
  await userEvent.click(await screen.findByRole("option", { name: "docs-site" }));
  await screen.findByText("No past sessions for this project.");
  expect(screen.queryByText("Fix the old retry loop")).toBeNull();
});
