import { ThreadId } from "@ace/protocol";
import { devWorld, facts, flakyCheckout, workbench, type Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const toasts = () => screen.getByRole("region", { name: "Notifications" });
const inList = async (title: string) =>
  within(await screen.findByRole("navigation", { name: "Threads" })).findByText(title);

function crashingBuild(): Scenario {
  return {
    thread: {
      id: "thread-build",
      workspaceId: "relay",
      title: "Cut the 0.9 release build",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        label: "working",
        facts: [
          facts.rootAgent("codex"),
          facts.turn("root"),
          facts.message("root", "request", "user", "Cut the 0.9 release build"),
        ],
      },
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

const request = "Run rm -rf node_modules/.cache/vitest?";

test("a thread that starts needing you raises a toast naming the request, and Review opens it", async () => {
  const app = harness();
  const checkout = app.play(flakyCheckout());
  checkout.runThrough("watcher-started");
  // New thread shows the thread list without opening a thread (whose own toasts stay quiet).
  await app.open("/new");
  await inList("Fix flaky checkout test");

  checkout.runThrough("approval-requested");

  expect(await within(toasts()).findByText(request)).toBeTruthy();
  expect(within(toasts()).getByText("billing-api · Fix flaky checkout test")).toBeTruthy();
  // The tab's title carries the count while something waits.
  expect(document.title).toMatch(/^\(1\)/);
  await userEvent.click(within(toasts()).getByRole("button", { name: "Review" }));
  await screen.findByRole("heading", { level: 1, name: "Activity" });
  // Just that request, on its own.
  expect(await screen.findByRole("article", { name: request })).toBeTruthy();
  expect(screen.getAllByRole("article")).toHaveLength(1);
  await waitFor(() => expect(within(toasts()).queryByText(request)).toBeNull());
});

test("a needs-you toast goes once the request is answered", async () => {
  const app = harness();
  const checkout = app.play(flakyCheckout());
  checkout.runThrough("watcher-started");
  await app.open("/new");
  await inList("Fix flaky checkout test");
  checkout.runThrough("approval-requested");
  await within(toasts()).findByText(request);

  await userEvent.click(within(toasts()).getByRole("button", { name: "Review" }));
  const card = await screen.findByRole("article", { name: request });
  await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));

  await waitFor(() => expect(within(toasts()).queryByText(request)).toBeNull());
});

test("while the window is in the background no toast is raised", async () => {
  const app = harness();
  const checkout = app.play(flakyCheckout());
  checkout.runThrough("watcher-started");
  await app.open("/new");
  await inList("Fix flaky checkout test");
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  try {
    checkout.runThrough("approval-requested");
    const views = screen.getByRole("navigation", { name: "App" });
    await within(views).findByLabelText("1 needs you");
    expect(within(toasts()).queryByText(request)).toBeNull();
    expect(within(toasts()).queryByText(/needs you/)).toBeNull();
  } finally {
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("threads already waiting when the app connects don't raise toasts", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new");
  await inList("Retry budget for app-server restarts");
  await app.client.request({ type: "notification.config" });
  expect(within(toasts()).queryByText(/needs you/)).toBeNull();
});

test("reopening the fake world restores the cleanup approval without repeating its toast", async () => {
  const app = harness();
  const checkout = devWorld().find((entry) => entry.scenario.thread.id === "thread-checkout");
  if (!checkout) throw new Error("Missing checkout fixture");
  const player = app.play(checkout.scenario);
  if (checkout.through) player.runThrough(checkout.through);
  else if (!checkout.live) player.runUntilBlocked();
  await app.open("/t/thread-checkout");
  expect(await screen.findByRole("article", { name: request })).toBeTruthy();
  await app.client.request({ type: "notification.config" });
  expect(within(toasts()).queryByText(request)).toBeNull();
});

test("a thread that fails raises a toast that opens it", async () => {
  const app = harness();
  const build = app.play(crashingBuild());
  build.runThrough("working");
  await app.open("/new");
  await inList("Cut the 0.9 release build");

  build.runThrough("failed");

  expect(await within(toasts()).findByText("Cut the 0.9 release build failed")).toBeTruthy();
  // A failure is announced as one, at once; F6 reaches its action.
  expect(screen.getByRole("alert")).toBeTruthy();
  await userEvent.keyboard("{F6}");
  await userEvent.click(await within(toasts()).findByRole("button", { name: "Open" }));
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { level: 1, name: /Cut the 0.9 release build/ }),
    ).toBeTruthy(),
  );
});

test("turning a toast off in Settings silences it", async () => {
  const app = harness();
  const checkout = app.play(flakyCheckout());
  checkout.runThrough("watcher-started");
  await app.open("/activity");
  await screen.findByRole("heading", { level: 1, name: "Activity" });

  await userEvent.click(screen.getByRole("link", { name: "Settings" }));
  await userEvent.click(await screen.findByRole("link", { name: "Notifications" }));
  const needsYou = await screen.findByRole("switch", { name: "Needs you" });
  expect(needsYou.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(needsYou);
  expect(needsYou.getAttribute("aria-checked")).toBe("false");

  checkout.runThrough("approval-requested");

  const views = screen.getByRole("navigation", { name: "App" });
  await within(views).findByLabelText("1 needs you");
  expect(within(toasts()).queryByText("billing-api · needs you")).toBeNull();
  expect(JSON.parse(localStorage.getItem("ace.notifications.toasts") ?? "{}")).toMatchObject({
    needsYou: false,
  });
});

test("an agent message opens its thread and respects the category toggle", async () => {
  const app = harness();
  app.play(flakyCheckout()).runThrough("watcher-started");
  await app.open("/settings/notifications");
  const toggle = await screen.findByRole("switch", { name: "Agent messages" });
  const say = (id: string, message: string) =>
    app.daemon.notify({
      id,
      threadId: ThreadId.parse("thread-checkout"),
      title: "Fix flaky checkout test",
      status: "agent_says",
      message,
      backgroundCount: 0,
      actions: [],
    });
  say("ready", "Your preview is ready.");
  expect(await within(toasts()).findByText("Agent message · Fix flaky checkout test")).toBeTruthy();
  await within(toasts()).findByText("Your preview is ready.");
  say("ready", "Your preview is ready.");
  expect(within(toasts()).getAllByText("Your preview is ready.")).toHaveLength(1);
  await userEvent.click(toggle);
  say("quiet", "Keep this quiet.");
  await app.client.request({ type: "notification.config" });
  expect(within(toasts()).queryByText("Keep this quiet.")).toBeNull();
  await userEvent.click(within(toasts()).getByRole("button", { name: "Open" }));
  await screen.findByRole("feed", { name: "Transcript" });
  expect(screen.getByRole("heading", { level: 1, name: /Fix flaky checkout test/ })).toBeTruthy();
});
