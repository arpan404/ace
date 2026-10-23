import { facts, fixtureImage } from "@ace/fake-daemon";
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
const transcript = () => screen.getByRole("feed", { name: "Transcript" });
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

  // The fork carries the conversation it continues: its transcript opens on the source's
  // history (once), then a Forked from divider, then its own first message.
  const feed = within(screen.getByRole("feed", { name: "Transcript" }));
  expect(await feed.findByText("hi")).toBeTruthy();
  await waitFor(() => expect(feed.queryByText("yo")).not.toBeNull());
  expect(feed.getAllByText("yo")).toHaveLength(1);
  expect(feed.getByText("Hey! What are we building?")).toBeTruthy();
  const notes = await feed.findAllByRole("note");
  const marker = notes.find((note) => note.textContent?.startsWith("Forked from"));
  expect(marker).toBeTruthy();
  const own = feed.getByText("hi");
  const ask = feed.getByText("yo");
  if (!marker) throw new Error("No Forked from divider");
  expect(
    Boolean(ask.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      Boolean(marker.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING),
  ).toBe(true);
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

test("an ACP agent's model can be picked from another provider's thread, and nothing is sent yet", async () => {
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
  // A picked ACP model names its agent, so the thread can move to it like any provider.
  expect(row).toBeTruthy();
  expect(row?.getAttribute("aria-disabled")).not.toBe("true");
  expect(row?.textContent).not.toContain("Starts new threads only");
  expect(thread(app, "cursor-greeting")?.switch).toBeUndefined();
});

test("files attached to the message go with it to the new thread, once", async () => {
  const app = await openCursorThread();
  const png = Uint8Array.from(atob(fixtureImage.data), (char) => char.charCodeAt(0));
  await userEvent.upload(screen.getByLabelText("Files to attach"), [
    new File([png], "replay.png", { type: "image/png" }),
    new File(["remember the margin"], "notes.txt", { type: "text/plain" }),
  ]);
  const chips = screen.getByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());

  await chooseModel("GPT-5 Codex", "Codex", /^Model: Composer 2\.5/);
  const dialog = await screen.findByRole("dialog", { name: "Continue in a new thread?" });
  expect(within(dialog).getByText(/Its files go with it/)).toBeTruthy();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Codex" }));
  await userEvent.click(await screen.findByRole("combobox", { name: "Message" }));
  await userEvent.keyboard("look at these{Enter}");

  // The fork carries the conversation it continues, so the source's history stays visible
  // above the Forked from divider with the new message and its files below it.
  expect(await within(transcript()).findByRole("img", { name: "replay.png" })).toBeTruthy();
  await waitFor(() => expect(within(transcript()).queryByText("yo")).not.toBeNull());
  const continuedFeed = within(transcript());
  expect(continuedFeed.getAllByText("yo")).toHaveLength(1);
  expect(continuedFeed.getByText("look at these")).toBeTruthy();
  const continuedNotes = await continuedFeed.findAllByRole("note");
  expect(continuedNotes.some((note) => note.textContent?.startsWith("Forked from"))).toBe(true);
  const continued = threads(app).filter(
    (entry) => entry.lineage?.parentThreadId === "cursor-greeting",
  );
  expect(continued).toHaveLength(1);
  const view = app.daemon.snapshot({ kind: "thread", threadId: continued[0]!.id });
  const sent = Object.values(view?.kind === "thread" ? view.items : {}).filter(
    (item) => item.type === "message" && item.role === "user",
  );
  // The fork carries the source's history plus its own first message, each once: the new
  // message goes with its files a single time, not the inherited history.
  expect(sent).toHaveLength(2);
  const texts = sent.flatMap((item) =>
    item.type === "message"
      ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
  expect(texts.filter((text) => text === "yo")).toHaveLength(1);
  expect(texts.filter((text) => text === "look at these")).toHaveLength(1);
  expect(
    sent.filter((item) => item.type === "message" && item.inherited !== undefined),
  ).toHaveLength(1);
  const withFiles = sent.filter(
    (item) => item.type === "message" && (item.attachments?.length ?? 0) > 0,
  );
  expect(withFiles).toHaveLength(1);
  expect(withFiles[0]).toMatchObject({
    attachments: [
      expect.objectContaining({ name: "replay.png" }),
      expect.objectContaining({ name: "notes.txt" }),
    ],
  });
  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
});
