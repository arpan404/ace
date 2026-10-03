import { facts, flakyCheckout, workbench, type Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const toasts = () => screen.getByRole("region", { name: "Notifications" });

function crashingBuild(): Scenario {
  return {
    thread: {
      id: "thread-build",
      workspaceId: "relay",
      title: "Cut the 0.9 release build",
      provider: "codex",
    },
    steps: [
      { kind: "facts", label: "working", facts: [facts.rootAgent("codex"), facts.turn("root")] },
      {
        kind: "facts",
        label: "failed",
        facts: [
          facts.endTurn("root", "failed", { kind: "provider", message: "codex exited with 137" }),
        ],
      },
    ],
  };
}

test("a thread that starts needing you raises a toast that leads to Activity", async () => {
  const app = harness();
  const checkout = app.play(flakyCheckout());
  checkout.runThrough("watcher-started");
  await app.open("/");
  await screen.findByRole("heading", { level: 1, name: "Home" });
  await screen.findByText("Fix flaky checkout test");

  checkout.runThrough("approval-requested");

  await within(toasts()).findByText("Fix flaky checkout test");
  expect(within(toasts()).getByText("acme-web · needs you")).toBeTruthy();
  await userEvent.click(within(toasts()).getByRole("button", { name: "Answer" }));
  await screen.findByRole("heading", { level: 1, name: "Activity" });
  expect(
    await screen.findByRole("article", { name: "Run rm -rf node_modules/.cache/vitest?" }),
  ).toBeTruthy();
});

test("threads already waiting when the app connects don't raise toasts", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await screen.findByText("Retry budget for app-server restarts");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(within(toasts()).queryByText(/needs you/)).toBeNull();
});

test("a thread that fails raises a toast that opens it", async () => {
  const app = harness();
  const build = app.play(crashingBuild());
  build.runThrough("working");
  await app.open("/");
  await screen.findByText("Cut the 0.9 release build");

  build.runThrough("failed");

  expect(await within(toasts()).findByText("relay · failed")).toBeTruthy();
  await userEvent.click(within(toasts()).getByRole("button", { name: "Open" }));
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { level: 1, name: /Cut the 0.9 release build/ }),
    ).toBeTruthy(),
  );
});

test("turning a toast off in Activity's toast settings silences it", async () => {
  const app = harness();
  const checkout = app.play(flakyCheckout());
  checkout.runThrough("watcher-started");
  await app.open("/activity");
  await screen.findByRole("heading", { level: 1, name: "Activity" });

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Toast settings…" }));
  const dialog = await screen.findByRole("dialog", { name: "Toasts on this device" });
  const needsYou = within(dialog).getByRole("switch", { name: "When a thread needs you" });
  expect(needsYou.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(needsYou);
  expect(needsYou.getAttribute("aria-checked")).toBe("false");
  await userEvent.keyboard("{Escape}");

  await userEvent.click(
    within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", { name: "Home" }),
  );
  await screen.findByRole("heading", { level: 1, name: "Home" });
  checkout.runThrough("approval-requested");

  const rail = screen.getByRole("navigation", { name: "Views" });
  await within(rail).findByLabelText("1 need you");
  expect(within(toasts()).queryByText("acme-web · needs you")).toBeNull();
  expect(JSON.parse(localStorage.getItem("ace.notifications.toasts") ?? "{}")).toMatchObject({
    needsYou: false,
  });
});
