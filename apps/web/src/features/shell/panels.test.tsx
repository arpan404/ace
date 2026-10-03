import { failingSubagent } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

async function openThread(storage = memoryKeyValue()) {
  const app = harness({ storage });
  app.play(failingSubagent()).step();
  const view = await app.open("/t/thread-settings");
  await screen.findByRole("heading", { level: 1, name: "Migrate settings schema" });
  return { view, storage };
}
const region = (name: string) => screen.queryByRole("region", { name });
const selectedTab = (panel: HTMLElement) =>
  within(panel).getByRole("tab", { selected: true }).textContent;

test("⌘⇧D and ⌘J switch the right panel's tab, and the same shortcut again closes it", async () => {
  await openThread();
  expect(region("Thread panel")).toBeNull();

  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(selectedTab(panel)).toBe("Changes");

  await userEvent.keyboard("{Meta>}j{/Meta}");
  expect(selectedTab(panel)).toBe("Agents");

  await userEvent.keyboard("{Meta>}j{/Meta}");
  await waitFor(() => expect(region("Thread panel")).toBeNull());
});

test("the bottom panel opens independently and keeps its size across a reload", async () => {
  const { view, storage } = await openThread();
  await userEvent.click(screen.getByRole("button", { name: "Bottom panel" }));
  const bottom = await screen.findByRole("region", { name: "Bottom panel" });
  expect(region("Thread panel")).toBeNull();
  expect(selectedTab(bottom)).toBe("Terminal");
  expect(screen.getByRole("button", { name: "Bottom panel" }).getAttribute("aria-pressed")).toBe(
    "true",
  );

  const handle = within(bottom).getByRole("separator", { name: "Resize bottom panel" });
  expect(handle.getAttribute("aria-valuenow")).toBe("240");
  handle.focus();
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  expect(handle.getAttribute("aria-valuenow")).toBe("272");

  view.unmount();
  await openThread(storage);
  const restored = await screen.findByRole("region", { name: "Bottom panel" });
  expect(
    within(restored)
      .getByRole("separator", { name: "Resize bottom panel" })
      .getAttribute("aria-valuenow"),
  ).toBe("272");

  await userEvent.keyboard("{Control>}`{/Control}");
  await waitFor(() => expect(region("Bottom panel")).toBeNull());
});
