import { failingSubagent } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the agent tree shows subagents as they spawn and marks the one that fails", async () => {
  const app = harness();
  const script = app.play(failingSubagent());
  script.step();
  await app.open("/t/thread-settings");
  await screen.findByRole("heading", { level: 1, name: "Migrate settings schema" });

  await userEvent.keyboard("{Meta>}j{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: "Agents", selected: true })).toBeTruthy();
  await within(panel).findByRole("group", { name: "Main agent: Working" });
  expect(within(panel).queryByRole("group", { name: /migration-tester/ })).toBeNull();

  await act(async () => script.runThrough("workers-spawned"));
  await within(panel).findByRole("group", { name: "schema-writer: Working" });
  await within(panel).findByRole("group", { name: "migration-tester: Working" });

  await act(async () => script.runThrough("tester-failed"));
  const failed = await within(panel).findByRole("group", { name: "migration-tester: Failed" });
  expect(within(failed).getByText(/Context window exceeded/)).toBeTruthy();
  expect(within(panel).getByRole("group", { name: "schema-writer: Working" })).toBeTruthy();
});
