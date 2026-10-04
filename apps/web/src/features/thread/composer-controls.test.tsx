import { longHistory, replayCursor } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function open(scenario: "idle" | "busy") {
  const app = harness();
  if (scenario === "idle") app.play(longHistory(2)).runUntilBlocked();
  else app.play(replayCursor()).runThrough("finding");
  await app.open(scenario === "idle" ? "/t/thread-router" : "/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const message = (await screen.findByRole("combobox", { name: "Message" })) as HTMLTextAreaElement;
  return { app, message };
}
const thread = (app: ReturnType<typeof harness>, id: string) => {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) });
  return view?.kind === "thread" ? view.thread : undefined;
};
/** A menu that just closed still animates out; wait before opening the next. */
const menuClosed = () => waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

test("+ offers files, images, a mention and a command instead of a bare file dialog", async () => {
  const { message } = await open("idle");
  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  const menu = await screen.findByRole("menu");
  for (const name of ["Files", "Images", "Mention a file", "Command"])
    expect(within(menu).getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeTruthy();

  await userEvent.click(within(menu).getByRole("menuitem", { name: /^Mention a file/ }));
  expect(message.value).toBe("@");
  expect(await screen.findByRole("listbox", { name: "Files" })).toBeTruthy();
});

test("a file mentioned once is offered again under Recent files", async () => {
  const { message } = await open("idle");
  await userEvent.type(message, "Look at @check");
  await screen.findByRole("listbox", { name: "Files" });
  await userEvent.keyboard("{Enter}");
  const picked = message.value.trim().slice("Look at @".length);
  await userEvent.clear(message);

  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: `Mention ${picked}` }));
  expect(message.value).toBe(`@${picked} `);
});

test("Command waits for an empty message, and says so", async () => {
  const { message } = await open("idle");
  await userEvent.type(message, "Already writing");
  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  const command = await screen.findByRole("menuitem", { name: /^Command/ });
  expect(command.getAttribute("aria-disabled")).toBe("true");
  expect(command.textContent).toContain("Commands go at the start of an empty message");
});

test("a search that finds nothing says so instead of closing", async () => {
  const { message } = await open("idle");
  await userEvent.type(message, "@zzqqxx");
  expect(await screen.findByText("No files match “zzqqxx”")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByText("No files match “zzqqxx”")).toBeNull();
});

test("approvals show the thread's mode and what the provider gates, and change from the footer", async () => {
  const { app } = await open("busy");
  const chip = await screen.findByRole("button", { name: "Approvals: Auto-review" });
  await userEvent.click(chip);
  const auto = await screen.findByRole("menuitemradio", { name: "Auto-review" });
  expect(auto.getAttribute("aria-checked")).toBe("true");
  expect(auto.textContent).toContain("Gates edits, shell commands, network and protected reads");
  const full = screen.getByRole("menuitemradio", { name: "Full access" });
  expect(full.textContent).toContain("Nothing is gated");

  await userEvent.click(screen.getByRole("menuitemradio", { name: "Read only" }));
  // The agent is mid-turn: the new mode waits for the turn to end.
  expect(
    await screen.findByRole("button", { name: "Approvals: Read only, applies after this turn" }),
  ).toBeTruthy();
  expect(thread(app, "thread-replay-cursor")?.permission?.override).toBe("read-only");

  await menuClosed();
  await userEvent.click(screen.getByRole("button", { name: /^Approvals: Read only/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Use the default/ }));
  await waitFor(() => expect(thread(app, "thread-replay-cursor")?.permission?.override).toBeNull());
});

test("effort changes on a running thread from the next turn", async () => {
  const { app } = await open("busy");
  await userEvent.click(await screen.findByRole("button", { name: "Model: Opus 4.1, personal" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "high effort" }));

  expect(
    await screen.findByRole("button", { name: "Model: Opus 4.1, personal, high effort" }),
  ).toBeTruthy();
  const pending = thread(app, "thread-replay-cursor")?.switch;
  expect(pending).toMatchObject({ state: "queued", selection: { options: { effort: "high" } } });
});

test("a model without effort levels explains why there is nothing to choose", async () => {
  await open("idle");
  await userEvent.click(
    await screen.findByRole("button", { name: /^Model: Sonnet 4.5 \(OpenCode\)/ }),
  );
  const effort = await screen.findByRole("menuitem", { name: /Default/ });
  expect(effort.getAttribute("aria-disabled")).toBe("true");
  expect(effort.textContent).toContain("Sonnet 4.5 (OpenCode) has no effort levels");
});

test("while the agent works, a draft offers Queue and never turns into Stop", async () => {
  const { message } = await open("busy");
  expect(screen.getByRole("button", { name: "Stop the agent" })).toBeTruthy();
  await userEvent.type(message, "Also check cold start");
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  expect(screen.getByRole("button", { name: "Queue message" })).toBeTruthy();
});
