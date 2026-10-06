import { longHistory } from "@ace/fake-daemon";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * Files reach the composer from anywhere on the thread: dropped on the transcript (with an
 * overlay while they are dragged over), pasted while no field has focus, or dropped as a
 * folder, whose files attach up to a bound. A drag is the browser's, so its transfer and a
 * folder's entries are plain objects shaped as the browser hands them over.
 */

beforeEach(() => localStorage.clear());

async function openThread() {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-router");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await screen.findByRole("combobox", { name: "Message" });
  return { app, feed };
}

function transfer(files: File[], items: object[] = []) {
  return { types: ["Files"], files, items, dropEffect: "none" };
}

const fileEntry = (file: File) => ({
  isFile: true,
  isDirectory: false,
  name: file.name,
  file: (done: (file: File) => void) => done(file),
});

/** A folder whose reader hands its entries out in batches of 20, then an empty batch. */
const folderEntry = (name: string, children: object[]) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let at = 0;
    return {
      readEntries: (done: (batch: object[]) => void) => {
        at += 20;
        done(children.slice(at - 20, at));
      },
    };
  },
});

test("files dragged over the transcript show where they go, and dropping attaches them", async () => {
  const { feed } = await openThread();
  const notes = new File(["QA_TOKEN 42"], "notes.txt", { type: "text/plain" });
  fireEvent.dragEnter(feed, { dataTransfer: transfer([notes]) });
  expect(screen.getByText("Drop files to attach")).toBeTruthy();
  // A drag carrying no files (a text selection) isn't a drop of files.
  fireEvent.dragLeave(feed, { dataTransfer: transfer([notes]) });
  expect(screen.queryByText("Drop files to attach")).toBeNull();
  fireEvent.dragEnter(feed, { dataTransfer: { types: ["text/plain"], files: [], items: [] } });
  expect(screen.queryByText("Drop files to attach")).toBeNull();

  fireEvent.dragEnter(feed, { dataTransfer: transfer([notes]) });
  fireEvent.drop(feed, { dataTransfer: transfer([notes]) });
  expect(screen.queryByText("Drop files to attach")).toBeNull();
  const chips = await screen.findByRole("list", { name: "Attachments" });
  expect(within(chips).getByRole("button", { name: "Preview notes.txt" })).toBeTruthy();
});

test("files pasted while no field has focus attach to the composer", async () => {
  await openThread();
  const shot = new File(["bytes"], "clip.txt", { type: "text/plain" });
  fireEvent.paste(document.body, { clipboardData: { files: [shot], items: [] } });
  const chips = await screen.findByRole("list", { name: "Attachments" });
  expect(within(chips).getByRole("button", { name: "Preview clip.txt" })).toBeTruthy();
});

test("a dropped folder attaches its first 50 files, skipping hidden ones, and says so", async () => {
  const { feed } = await openThread();
  const inner = Array.from({ length: 30 }, (_, index) =>
    fileEntry(new File([`b${index}`], `b${index}.txt`)),
  );
  const children = [
    fileEntry(new File(["secret"], ".env")),
    folderEntry(".git", [fileEntry(new File(["ref"], "HEAD"))]),
    ...Array.from({ length: 25 }, (_, index) =>
      fileEntry(new File([`a${index}`], `a${index}.txt`)),
    ),
    folderEntry("nested", inner),
  ];
  const folder = folderEntry("shots", children);
  fireEvent.drop(feed, {
    dataTransfer: transfer(
      [new File([], "shots")],
      [{ kind: "file", webkitGetAsEntry: () => folder }],
    ),
  });
  expect(
    await screen.findByText(
      "Attached the first 50 files. A dropped folder adds up to 50; hidden files are skipped.",
    ),
  ).toBeTruthy();
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() =>
    expect(within(chips).getAllByRole("button", { name: /^Preview / })).toHaveLength(50),
  );
  expect(within(chips).queryByRole("button", { name: "Preview .env" })).toBeNull();
  expect(within(chips).queryByRole("button", { name: "Preview HEAD" })).toBeNull();
  expect(within(chips).getByRole("button", { name: "Preview b24.txt" })).toBeTruthy();
  expect(within(chips).queryByRole("button", { name: "Preview b25.txt" })).toBeNull();
});
