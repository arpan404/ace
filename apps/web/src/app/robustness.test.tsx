import type { ComponentProps } from "react";
import { workbench } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

const failures = vi.hoisted(() => ({
  sidebar: false,
  palette: false,
  message: false,
  composer: false,
}));
vi.mock("@/features/home/index.ts", async (original) => {
  const actual = await original<typeof import("@/features/home/index.ts")>();
  return {
    ...actual,
    ThreadsSidebar() {
      if (failures.sidebar) throw new Error("broken sidebar");
      return <actual.ThreadsSidebar />;
    },
  };
});
vi.mock("@/features/palette/index.ts", async (original) => {
  const actual = await original<typeof import("@/features/palette/index.ts")>();
  return {
    ...actual,
    CommandPalette() {
      if (failures.palette) throw new Error("broken palette");
      return <actual.CommandPalette />;
    },
  };
});
vi.mock("@/features/thread/items/messages.tsx", async (original) => {
  const actual = await original<typeof import("@/features/thread/items/messages.tsx")>();
  return {
    ...actual,
    AssistantMessage(props: ComponentProps<typeof actual.AssistantMessage>) {
      if (failures.message) throw new Error("broken message");
      return <actual.AssistantMessage {...props} />;
    },
  };
});
vi.mock("@/features/thread/composer/message-input.tsx", async (original) => {
  const actual = await original<typeof import("@/features/thread/composer/message-input.tsx")>();
  return {
    ...actual,
    MessageInput(props: ComponentProps<typeof actual.MessageInput>) {
      if (failures.composer) throw new Error("broken composer");
      return <actual.MessageInput {...props} />;
    },
  };
});

afterEach(() => {
  Object.assign(failures, { sidebar: false, palette: false, message: false, composer: false });
  vi.restoreAllMocks();
});

for (const region of ["sidebar", "palette"] as const)
  test(`a broken ${region} keeps the selected page open and can be retried`, async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failures[region] = true;
    await harness().open("/settings/general");
    expect(await screen.findByRole("switch", { name: "New threads use a worktree" })).toBeTruthy();
    const toast = await screen.findByRole("alertdialog");
    expect(screen.queryByText("ace couldn't start")).toBeNull();
    failures[region] = false;
    await userEvent.click(within(toast).getByRole("button", { name: "Try again" }));
    if (region === "sidebar")
      expect(await screen.findByRole("complementary", { name: "Settings" })).toBeTruthy();
    else {
      await userEvent.keyboard("{Meta>}k{/Meta}");
      expect(await screen.findByRole("combobox", { name: "Search commands" })).toBeTruthy();
    }
  });

test("a broken transcript message leaves Send and the other messages available", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  failures.message = true;
  await app.open("/t/thread-fan-out");
  expect(await screen.findByText("Couldn't show this message.")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Message" })).toBeTruthy();
  expect(screen.queryByText("ace couldn't start")).toBeNull();
});

test("a broken composer leaves the thread visible and can be reopened", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  failures.composer = true;
  await app.open("/t/thread-fan-out");
  const failed = await screen.findByText("Couldn't show the composer.");
  expect(screen.getByRole("feed", { name: "Transcript" })).toBeTruthy();
  failures.composer = false;
  if (!failed.parentElement) throw new Error("Missing composer recovery");
  await userEvent.click(within(failed.parentElement).getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("combobox", { name: "Message" })).toBeTruthy();
});
