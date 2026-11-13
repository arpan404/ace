import type { FakeSpadeApi } from "@ace/fake-daemon";
import { fakeFileRevision } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

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

async function editing(text: string) {
  const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "plan.md" });
  await waitFor(() => expect(editor.value).toBe("# Plan\n"));
  fireEvent.change(editor, { target: { value: text } });
  return editor;
}

test("a save over a file the bot changed since it was opened shows the conflict, and Reload reads it again", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", (api) => {
    seed(api);
    api.files.set("scout", { "plan.md": "# Plan\n" });
  });
  const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "plan.md" });
  await waitFor(() => expect(editor.value).toBe("# Plan\n"));
  fireEvent.change(editor, { target: { value: "# Plan\nMine" } });
  // Meanwhile the bot wrote it.
  const scoutFiles = spade.files.get("scout");
  if (scoutFiles) scoutFiles["plan.md"] = "# Plan\nScout's";
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  const conflict = await screen.findByRole("alert");
  expect(conflict.textContent).toContain("Changed since you opened it");
  // Nothing was written over the bot's words.
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nScout's");
  expect(editor.value).toBe("# Plan\nMine");

  await userEvent.click(within(conflict).getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(editor.value).toBe("# Plan\nScout's"));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Overwrite saves the person's draft over the file as it is now", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", (api) => {
    seed(api);
    api.files.set("scout", { "plan.md": "# Plan\n" });
  });
  const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "plan.md" });
  await waitFor(() => expect(editor.value).toBe("# Plan\n"));
  fireEvent.change(editor, { target: { value: "# Plan\nMine" } });
  const scoutFiles = spade.files.get("scout");
  if (scoutFiles) scoutFiles["plan.md"] = "# Plan\nScout's";
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  const conflict = await screen.findByRole("alert");
  await userEvent.click(within(conflict).getByRole("button", { name: "Overwrite" }));
  await waitFor(() => expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nMine"));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("a save after the bot's change was read in meanwhile still names what the person began from", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", seed);
  const editor = await editing("# Plan\nMine");
  // The bot writes the file; its stream says so, and the editor reads the file again.
  const reads = () =>
    spade.requests.filter((request) => request.path.includes("/workspace/file?path=plan.md"))
      .length;
  const before = reads();
  spade.computer.botWrites("scout", "plan.md", "# Plan\nScout's");
  await waitFor(() => expect(reads()).toBeGreaterThan(before));
  // The draft stays on show, and the save is refused rather than written over the bot's words.
  expect(editor.value).toBe("# Plan\nMine");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Changed since you opened it");
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nScout's");
  expect(spade.sent("PUT", "/v1/agents/scout/files?path=plan.md")).toEqual([
    { text: "# Plan\nMine", base: fakeFileRevision("# Plan\n") },
  ]);
});

test("Overwrite writes the draft with no base, even over a file the bot deleted", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", seed);
  await editing("# Plan\nMine");
  const scoutFiles = spade.files.get("scout");
  if (scoutFiles) delete scoutFiles["plan.md"];
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  const conflict = await screen.findByRole("alert");
  await userEvent.click(within(conflict).getByRole("button", { name: "Overwrite" }));
  await waitFor(() => expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nMine"));
  expect(spade.sent("PUT", "/v1/agents/scout/files?path=plan.md").at(-1)).toEqual({
    text: "# Plan\nMine",
  });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("a refused Overwrite keeps the person's draft", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=files&file=plan.md", seed);
  const editor = await editing("# Plan\nMine");
  spade.computer.botWrites("scout", "plan.md", "# Plan\nScout's");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  const conflict = await screen.findByRole("alert");
  spade.computer.failSaves = "disk full";
  await userEvent.click(within(conflict).getByRole("button", { name: "Overwrite" }));
  await screen.findAllByText(/Couldn't save plan\.md/);
  expect(editor.value).toBe("# Plan\nMine");
  expect(spade.files.get("scout")?.["plan.md"]).toBe("# Plan\nScout's");
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
