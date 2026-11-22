import type { FakeSpadeApi } from "@ace/fake-daemon";
import { fakeFileRevision } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { editorText, replaceEditorText } from "@/test/editor-text.ts";
import { spadeApp, withEndpoint } from "@/test/spade.ts";
import { openSource } from "@/test/spade-files.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/*
 * The person and the bot change the same files at once (cowork, ADR 0143): every write names
 * the revision the person saw, and one over a file that moved on since is refused, not lost.
 */

function seed(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  spade.addAgent({ id: "scout", name: "Scout" });
  spade.files.set("scout", { "plan.md": "# Plan\n" });
}

/** The person opens plan.md's source and types `text` over it. */
async function editing(text: string, opened = "# Plan\n") {
  const { region, box } = await openSource("plan.md", opened);
  await replaceEditorText(userEvent.setup(), box, text);
  await waitFor(() => expect(editorText(region)).toBe(text.replaceAll("{Enter}", "\n")));
  return region;
}

/** The editor's status line, where a save that didn't go says why. */
const statusLine = () =>
  within(screen.getByRole("group", { name: "Editor" }))
    .getAllByRole("status")
    .at(-1);

test("a save over a file the bot changed since it was opened writes nothing, and Replace then writes over it", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", seed);
  const editor = await editing("# Plan{Enter}Mine");
  // Meanwhile the bot wrote it, unannounced.
  const scoutFiles = spade.files.get("scout");
  if (scoutFiles) scoutFiles["plan.md"] = "# Plan\nScout's";
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(statusLine()?.textContent).toContain("Scout changed plan.md since you opened it."),
  );
  // Nothing was written over the bot's words, and the person's stay on show.
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nScout's");
  expect(editorText(editor)).toBe("# Plan\nMine");

  await userEvent.click(screen.getByRole("button", { name: "Replace" }));
  await waitFor(() => expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nMine"));
  // Replace writes over the bot's version the person was told of, never a newer one.
  expect(spade.sent("PUT", "/v1/agents/scout/files?path=plan.md").at(-1)).toEqual({
    text: "# Plan\nMine",
    base: fakeFileRevision("# Plan\nScout's"),
  });
});

test("the bot writing under the person's edits names it with Merge, which keeps both changes", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", (api) => {
    seed(api);
    api.files.set("scout", { "plan.md": "# Plan\nDay 1\n" });
  });
  const { region, box } = await openSource("plan.md", "# Plan\nDay 1\n");
  // The person retitles it; the bot adds a day, and its stream says the files changed.
  await userEvent.click(box);
  await userEvent.keyboard("{Control>}{Home}{/Control}{End} for Lisbon");
  await waitFor(() => expect(editorText(region)).toBe("# Plan for Lisbon\nDay 1\n"));
  spade.computer.botWrites("scout", "plan.md", "# Plan\nDay 1\nDay 2\n");
  const notice = await screen.findByText(/^Scout changed/);
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nDay 1\nDay 2\n");
  expect(notice.closest("[role=status]")).not.toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(editorText(region)).toBe("# Plan for Lisbon\nDay 1\nDay 2\n"));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan for Lisbon\nDay 1\nDay 2\n"),
  );
});

test("with no draft, a change the bot makes to the open file shows as it lands", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", seed);
  await openSource("plan.md", "# Plan\n");
  spade.computer.botWrites("scout", "plan.md", "# Plan\nScout's");
  await waitFor(() =>
    expect(editorText(screen.getByRole("region", { name: "Source of plan.md" }))).toBe(
      "# Plan\nScout's",
    ),
  );
});

test("a file the bot deleted under the person's edits is written again only when they say so", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", seed);
  await editing("# Plan{Enter}Mine");
  const scoutFiles = spade.files.get("scout");
  if (scoutFiles) delete scoutFiles["plan.md"];
  spade.computer.botWrites("scout", "other.md", "x");
  await userEvent.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(statusLine()?.textContent).toContain("Scout deleted plan.md since you opened it."),
  );
  expect(spade.files.get("scout")?.["plan.md"]).toBeUndefined();
  await userEvent.click(screen.getByRole("button", { name: "Save it again" }));
  await waitFor(() => expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nMine"));
});

test("a save that fails says why and keeps the person's draft", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", seed);
  const editor = await editing("# Plan{Enter}Mine");
  spade.computer.failSaves = "disk full";
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(statusLine()?.textContent).toContain("disk full"));
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(editorText(editor)).toBe("# Plan\nMine");
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\n");
});

test("a Markdown file opens rendered, and Source shows its text to edit", async () => {
  await spadeApp("/spade/scout?computer=files&file=plan.md", (api) => {
    seed(api);
    api.files.set("scout", { "plan.md": "# Plan\n\n- Day 1: Sintra\n" });
  });
  await screen.findByRole("button", { name: "Preview", pressed: true });
  await screen.findByRole("heading", { name: "Plan" });
  expect(screen.queryByRole("region", { name: "Source of plan.md" })).toBeNull();
  await openSource("plan.md", "# Plan\n\n- Day 1: Sintra\n");
});

test("files open as tabs: a click glances, and the files stay listed beside the editor", async () => {
  await spadeApp("/spade/scout?computer=files", (api) => {
    seed(api);
    api.files.set("scout", {
      "plan.md": "# Plan\n",
      "notes.txt": "milk",
      "trips/day.txt": "Sintra",
    });
  });
  const files = await screen.findByRole("list", { name: "Files" });
  await userEvent.click(await within(files).findByRole("button", { name: "notes.txt" }));
  await screen.findByRole("region", { name: "Source of notes.txt" });
  await userEvent.click(within(files).getByRole("button", { name: "trips" }));
  await userEvent.dblClick(await within(files).findByRole("button", { name: "day.txt" }));
  const source = await screen.findByRole("region", { name: "Source of trips/day.txt" });
  await waitFor(() => expect(editorText(source)).toBe("Sintra"));
  // The glance gave way to the kept file; the tree stays beside it.
  const tabs = screen.getByRole("tablist", { name: "Open files" });
  expect(
    within(tabs)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual([expect.stringContaining("day.txt")]);
  expect(within(files).getByRole("button", { name: "plan.md" })).toBeTruthy();
});

test("delete, move and replacing upload name the revision the person saw, and are refused once it moved on", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files", seed);
  const files = await screen.findByRole("list", { name: "Files" });

  // Delete: the question opens, the bot changes the file, the answer is refused.
  await userEvent.click(within(files).getByRole("button", { name: "More for plan.md" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const confirm = within(await screen.findByRole("dialog", { name: "Delete plan.md?" }));
  await waitFor(() =>
    expect(
      spade.requests.some((request) => request.path.includes("/workspace/file?path=plan.md")),
    ).toBe(true),
  );
  spade.computer.botWrites("scout", "plan.md", "# Plan\nScout's");
  await userEvent.click(confirm.getByRole("button", { name: "Delete" }));
  await screen.findAllByText(/changed since you opened it/);
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nScout's");

  // Move: named by the revision read when the rename began.
  await userEvent.click(within(files).getByRole("button", { name: "More for plan.md" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename or move" }));
  const name = screen.getByRole("textbox", { name: "New name or path for plan.md" });
  await userEvent.clear(name);
  await userEvent.type(name, "trip.md{Enter}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/scout/files/move")).toEqual([
      { from: "plan.md", to: "trip.md", base: fakeFileRevision("# Plan\nScout's") },
    ]),
  );

  // Upload over trip.md: names the revision shown; a new name goes with none.
  await within(await screen.findByRole("list", { name: "Files" })).findByRole("button", {
    name: /^trip\.md/,
  });
  fireEvent.change(screen.getByLabelText("Files to upload"), {
    target: { files: [new File(["new"], "trip.md"), new File(["n"], "notes.txt")] },
  });
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/scout/files/upload")).toEqual([
      { path: "trip.md", data_b64: btoa("new"), base: fakeFileRevision("# Plan\nScout's") },
      { path: "notes.txt", data_b64: btoa("n") },
    ]),
  );
});

/** Spade's file writes and deletes the app sent so far. */
const writes = (spade: FakeSpadeApi) =>
  spade.requests.filter(
    (request) =>
      (request.method === "POST" && request.path.includes("/files/")) ||
      (request.method === "DELETE" && request.path.includes("/workspace")),
  );

async function menu(name: string, item: string) {
  const files = await screen.findByRole("list", { name: "Files" });
  await userEvent.click(within(files).getByRole("button", { name: `More for ${name}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

async function rename(from: string, to: string) {
  await menu(from, "Rename or move");
  const name = screen.getByRole("textbox", { name: `New name or path for ${from}` });
  await userEvent.clear(name);
  await userEvent.type(name, `${to}{Enter}`);
}

test("a file that can't be checked is never deleted, moved or replaced unchecked", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files", seed);
  await screen.findByRole("list", { name: "Files" });
  spade.fileReadFailure = 500;

  await menu("plan.md", "Delete");
  const confirm = within(await screen.findByRole("dialog", { name: "Delete plan.md?" }));
  await userEvent.click(confirm.getByRole("button", { name: "Delete" }));
  await screen.findAllByText("Couldn't check the file. Try again.");

  await rename("plan.md", "trip.md");
  fireEvent.change(screen.getByLabelText("Files to upload"), {
    target: { files: [new File(["new"], "plan.md"), new File(["n"], "notes.txt")] },
  });
  // Only the new file goes; nothing that needed the check was sent.
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/scout/files/upload")).toEqual([
      { path: "notes.txt", data_b64: btoa("n") },
    ]),
  );
  expect(writes(spade).map((request) => request.path)).toEqual(["/v1/agents/scout/files/upload"]);
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\n");
});

test("a file gone since: delete says so and sends nothing, an upload writes it as new", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files", seed);
  await screen.findByRole("list", { name: "Files" });
  // The bot deletes it; the list still shows it.
  delete spade.files.get("scout")?.["plan.md"];

  await menu("plan.md", "Delete");
  const confirm = within(await screen.findByRole("dialog", { name: "Delete plan.md?" }));
  await userEvent.click(confirm.getByRole("button", { name: "Delete" }));
  await screen.findAllByText("plan.md is gone");
  expect(writes(spade)).toEqual([]);

  // Read again: the list no longer has it.
  await screen.findByText("Scout hasn't kept any files yet.");
  fireEvent.change(screen.getByLabelText("Files to upload"), {
    target: { files: [new File(["back"], "plan.md")] },
  });
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents/scout/files/upload")).toEqual([
      { path: "plan.md", data_b64: btoa("back") },
    ]),
  );
});

test("a move whose file is gone since says so and sends nothing", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files", seed);
  await screen.findByRole("list", { name: "Files" });
  delete spade.files.get("scout")?.["plan.md"];
  await rename("plan.md", "trip.md");
  await screen.findAllByText("plan.md is gone");
  expect(writes(spade)).toEqual([]);
});

test("a delete or move waits for the file's check, and goes only if the person may still act", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files", seed);
  await screen.findByRole("list", { name: "Files" });
  const release = spade.holdFileReads();

  await menu("plan.md", "Delete");
  const confirm = within(await screen.findByRole("dialog", { name: "Delete plan.md?" }));
  await userEvent.click(confirm.getByRole("button", { name: "Delete" }));
  await rename("plan.md", "trip.md");
  // While the checks are out, a take-over begins: the bot's work is still stopping.
  spade.computer.stopping("scout", true);
  spade.answer({ method: "POST", path: "/v1/agents/scout/computer/take-over", body: undefined });
  await screen.findByText("Stopping Scout…");
  release();
  await screen.findAllByText("Files can change once the computer is yours or shared again");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(writes(spade)).toEqual([]);
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\n");
});

test("Spade's own .spade folder stays out of the bot's files, its other folders show", async () => {
  await spadeApp("/spade/scout?computer=files", (api) => {
    seed(api);
    api.files.set("scout", {
      "plan.md": "# Plan\n",
      ".spade/state.json": "{}",
      "trips/lisbon.md": "Lisbon",
    });
  });
  const files = await screen.findByRole("list", { name: "Files" });
  await within(files).findByRole("button", { name: /^plan\.md/ });
  expect(within(files).getByRole("button", { name: /^trips/ })).toBeTruthy();
  expect(within(files).queryByRole("button", { name: /^\.spade/ })).toBeNull();
});
