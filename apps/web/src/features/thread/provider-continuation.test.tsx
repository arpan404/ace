import { facts } from "@ace/fake-daemon";
import { ThreadId, type Thread } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { chooseModel, openModelControl, openModelPicker } from "@/test/model-control.ts";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());

const threads = (app: ReturnType<typeof harness>): Thread[] => {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? Object.values(view.threads) : [];
};
const thread = (app: ReturnType<typeof harness>, id: string) =>
  threads(app).find((entry) => entry.id === ThreadId.parse(id));

/** A Cursor SDK thread that answered once: its checkpoint is pinned to it and its account. */
async function openCursorThread() {
  const app = harness();
  app.daemon.createThread({
    id: "cursor-greeting",
    workspaceId: "ace",
    title: "Respond to a Greeting",
    provider: "cursor",
    execution: { provider: "cursor", model: "composer-2.5", instanceId: "cursor", options: {} },
  });
  app.daemon.apply("cursor-greeting", [
    facts.rootAgent("cursor"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "yo"),
    facts.message("root", "answer", "assistant", "Hey! What are we building?"),
    facts.endTurn("root"),
  ]);
  await app.open("/t/cursor-greeting");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Hey! What are we building?");
  return app;
}

test("picking Codex on a Cursor thread sends the next message once to a new Codex thread with its context", async () => {
  const app = await openCursorThread();
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Composer 2\.5/);
  const dialog = await screen.findByRole("dialog", { name: "Continue in a new thread?" });
  expect(within(dialog).getByText(/This thread stays as it is/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Codex" }));
  // Nothing goes to the daemon until the person sends; the thread itself never switches.
  expect(thread(app, "cursor-greeting")?.switch).toBeUndefined();
  expect(await screen.findByRole("button", { name: /^Model: GPT-5 Codex/ })).toBeTruthy();

  await userEvent.click(await screen.findByRole("combobox", { name: "Message" }));
  await userEvent.keyboard("hi");
  await userEvent.keyboard("{Enter}");

  await waitFor(() =>
    expect(within(screen.getByRole("feed", { name: "Transcript" })).queryByText("yo")).toBeNull(),
  );
  expect(
    await within(screen.getByRole("feed", { name: "Transcript" })).findByText("hi"),
  ).toBeTruthy();
  const continued = threads(app).filter(
    (entry) => entry.lineage?.parentThreadId === "cursor-greeting",
  );
  expect(continued).toHaveLength(1);
  expect(continued[0]).toMatchObject({
    provider: "codex",
    title: "Respond to a Greeting",
    lineage: { mode: "portable", lossy: true, point: { type: "turn" } },
  });
  // The Cursor thread keeps its own history and provider; the message went only to Codex.
  expect(thread(app, "cursor-greeting")).toMatchObject({ provider: "cursor" });
  const source = app.daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse("cursor-greeting"),
  });
  const said = Object.values(source?.kind === "thread" ? source.items : {}).flatMap((item) =>
    item.type === "message" && item.role === "user"
      ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
  expect(said).toEqual(["yo"]);
});

test("an ACP agent says it starts new threads only before anything is sent", async () => {
  const app = await openCursorThread();
  const popover = await openModelControl(/^Model: Composer 2\.5/);
  await openModelPicker(popover);
  await userEvent.type(
    within(popover).getByRole("combobox", { name: "Search models" }),
    "Gemini 2.5 Pro",
  );
  const row = within(popover)
    .getAllByRole("option")
    .find((option) => option.getAttribute("aria-label")?.startsWith("Gemini 2.5 Pro"));
  expect(row?.getAttribute("aria-disabled")).toBe("true");
  expect(row?.textContent).toContain("Starts new threads only");
  expect(thread(app, "cursor-greeting")?.switch).toBeUndefined();
});
