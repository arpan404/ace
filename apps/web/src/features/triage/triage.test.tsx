import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
test("a described issue becomes an editable prompt that can be copied and survives a failed CLI launch", async () => {
  const user = userEvent.setup();
  await harness({ throughWorker: true }).open("/triage");
  const copied: string[] = [];
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
    copied.push(text);
  });
  await user.type(
    await screen.findByRole("textbox", { name: "Description" }),
    "The composer freezes after reconnecting.",
  );
  await user.click(screen.getByRole("button", { name: "Generate prompt" }));
  const preview = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Generated prompt",
  });
  expect(preview.value).toContain("The composer freezes after reconnecting.");
  expect(preview.value).toContain("SQLite integrity: ok");
  await user.clear(preview);
  await user.type(preview, "Investigate only the reconnect behavior.");
  await user.click(screen.getByRole("button", { name: "Copy prompt" }));
  await waitFor(() => expect(copied).toContain("Investigate only the reconnect behavior."));
  await user.click(screen.getByRole("button", { name: "Open in Claude Code" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Couldn't open the CLI"),
  );
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Generated prompt" }).value).toBe(
    "Investigate only the reconnect behavior.",
  );
});
test("doctor findings can be repaired and handed to triage with the latest check results", async () => {
  const user = userEvent.setup();
  await harness({ throughWorker: true }).open("/settings/advanced");
  await user.click(await screen.findByRole("button", { name: "Run checks" }));
  await user.click(await screen.findByRole("button", { name: "Run safe repairs" }));
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "Check results" }).textContent).toContain(
      "Node v24.1.0",
    ),
  );
  await user.click(screen.getByRole("button", { name: "Investigate with a CLI" }));
  const dialog = await screen.findByRole("dialog", { name: "ace triage" });
  await user.click(within(dialog).getByRole("button", { name: "Generate prompt" }));
  expect(
    (await within(dialog).findByRole<HTMLTextAreaElement>("textbox", { name: "Generated prompt" }))
      .value,
  ).toContain("Cursor CLI not installed");
});
