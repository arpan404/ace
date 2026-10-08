import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
async function openPi() {
  const app = harness();
  app.daemon.createThread({ id: "pi-rewind", workspaceId: "ace", title: "Try Pi", provider: "pi" });
  app.daemon.apply("pi-rewind", [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "pi", nativeId: "pi-session" },
      cwd: "/synthetic",
    },
    { type: "turn.started", agent: "root", nativeTurnId: "turn-1", trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: "answer",
      draft: {
        type: "message",
        role: "assistant",
        complete: true,
        nativeId: "entry-1",
        parts: [{ type: "text", text: "The first approach is ready." }],
      },
    },
    { type: "turn.ended", agent: "root", nativeTurnId: "turn-1", outcome: "completed" },
    { type: "turn.started", agent: "root", nativeTurnId: "turn-2", trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: "later-answer",
      draft: {
        type: "message",
        role: "assistant",
        complete: true,
        nativeId: "entry-2",
        parts: [{ type: "text", text: "The later approach is still visible." }],
      },
    },
    { type: "turn.ended", agent: "root", nativeTurnId: "turn-2", outcome: "completed" },
  ]);
  await app.open("/t/pi-rewind");
  await screen.findByText("The first approach is ready.");
  return app;
}

test("Pi rewind asks for confirmation, leaves files unchanged and keeps later conversation visible", async () => {
  await openPi();
  await screen.findAllByRole("button", { name: "Rewind to here" });
  const rewind = screen.getAllByRole("button", { name: "Rewind to here" })[0];
  if (!rewind) throw new Error("No rewind point");
  await userEvent.click(rewind);
  const dialog = await screen.findByRole("dialog", { name: "Rewind to here?" });
  expect(within(dialog).getByText(/Files are not reverted/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText("Conversation rewound")).toBeNull();
  await userEvent.click(rewind);
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Rewind to here?" })).getByRole("button", {
      name: "Rewind",
    }),
  );
  expect(await screen.findByText("Conversation rewound")).toBeTruthy();
  expect(screen.getByText("The first approach is ready.")).toBeTruthy();
  expect(screen.getByText("The later approach is still visible.")).toBeTruthy();
});

test("Pi rewind stays unavailable while any agent is working", async () => {
  const app = await openPi();
  app.daemon.apply("pi-rewind", [
    {
      type: "agent.seen",
      agent: "child",
      parent: "root",
      origin: "provider_subagent",
      fidelity: "full",
      native: { provider: "pi", nativeId: "child" },
      cwd: "/synthetic",
    },
    { type: "turn.started", agent: "child", nativeTurnId: "child-turn", trigger: "user" },
  ]);
  const button = (await screen.findAllByRole("button", { name: "Rewind to here" }))[0];
  if (!button) throw new Error("No rewind control");
  await userEvent.click(button);
  expect(screen.queryByRole("dialog", { name: "Rewind to here?" })).toBeNull();
  expect(button.getAttribute("aria-disabled")).toBe("true");
});
