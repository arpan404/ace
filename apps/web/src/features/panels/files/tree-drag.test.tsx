import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { bytes, expand, renderTree, row } from "./tree-test-support.tsx";

configure({ asyncUtilTimeout: 10000 });

/** A drag's data as a browser carries it from dragstart to drop. */
function transfer(files: File[] = []) {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys(), ...(files.length ? ["Files"] : [])];
    },
    files,
    effectAllowed: "all",
    dropEffect: "none",
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
}

test("dragging a file onto a folder row moves it there", async () => {
  const { client, tree } = await renderTree();
  const before = await bytes({ client }, "README.md");
  const dataTransfer = transfer();
  fireEvent.dragStart(await row(tree, "README.md"), { dataTransfer });
  const apps = await row(tree, "apps/");
  fireEvent.dragOver(apps, { dataTransfer });
  expect(dataTransfer.dropEffect).toBe("move");
  fireEvent.drop(apps, { dataTransfer });
  await waitFor(() => expect(tree.querySelector('[data-path="README.md"]')).toBeNull());
  expect(await bytes({ client }, "apps/README.md")).toBe(before);
});

test("a folder held under a drag opens by itself", async () => {
  const { tree } = await renderTree();
  const dataTransfer = transfer();
  fireEvent.dragStart(await row(tree, "README.md"), { dataTransfer });
  const apps = await row(tree, "apps/");
  fireEvent.dragEnter(apps, { dataTransfer });
  fireEvent.dragOver(apps, { dataTransfer });
  await waitFor(() => expect(apps.getAttribute("aria-expanded")).toBe("true"));
});

test("a folder never drops into itself, and the empty space below the rows is the root", async () => {
  const { client, tree } = await renderTree();
  await expand(tree, ["apps/", "apps/server/"]);
  const dataTransfer = transfer();
  fireEvent.dragStart(await row(tree, "apps/server/src/"), { dataTransfer });
  fireEvent.drop(await row(tree, "apps/server/src/"), { dataTransfer });
  expect(await row(tree, "apps/server/src/")).toBeTruthy();
  // Dropped on the tree's empty space, it goes to the checkout's root.
  const empty = document.querySelector<HTMLElement>('[data-part="tree-root"]');
  if (!empty) throw new Error("No empty tree space");
  fireEvent.dragOver(empty, { dataTransfer });
  fireEvent.drop(empty, { dataTransfer });
  await waitFor(() => expect(tree.querySelector('[data-path="src/"]')).toBeTruthy());
  expect(await bytes({ client }, "src/replay.ts")).toContain("COLD_START_WINDOW");
});

test("files dropped from outside still upload into the folder", async () => {
  const { tree, outputs } = await renderTree();
  const dataTransfer = transfer([new File(["dropped"], "dropped.txt")]);
  const apps = await row(tree, "apps/");
  fireEvent.dragOver(apps, { dataTransfer });
  expect(dataTransfer.dropEffect).toBe("copy");
  fireEvent.drop(apps, { dataTransfer });
  // The tab uploads what the tree hands it (files.test.tsx follows an upload into the checkout).
  expect(outputs.uploads).toEqual([{ names: ["dropped.txt"], folder: "apps/" }]);
});

test("dragging a selected row moves every selected row", async () => {
  const { tree } = await renderTree();
  const src = "apps/server/src/";
  await expand(tree, ["apps/", "apps/server/", src]);
  await userEvent.click(await row(tree, `${src}cursor.ts`));
  const user = userEvent.setup();
  await user.keyboard("{Control>}");
  await user.click(await row(tree, `${src}resume.ts`));
  await user.keyboard("{/Control}");
  const dataTransfer = transfer();
  fireEvent.dragStart(await row(tree, `${src}resume.ts`), { dataTransfer });
  fireEvent.drop(await row(tree, "apps/"), { dataTransfer });
  await waitFor(() => expect(tree.querySelector(`[data-path="${src}resume.ts"]`)).toBeNull());
  expect(tree.querySelector(`[data-path="${src}cursor.ts"]`)).toBeNull();
  expect(await row(tree, "apps/cursor.ts")).toBeTruthy();
  expect(await row(tree, "apps/resume.ts")).toBeTruthy();
});

test("rows dragged from another checkout's tree never move this checkout's files", async () => {
  const { client, tree, beside } = await renderTree({ beside: "thread-other-checkout" });
  if (!beside) throw new Error("No second tree");
  const before = await bytes({ client }, "README.md");
  const dataTransfer = transfer();
  fireEvent.dragStart(await row(beside, "README.md"), { dataTransfer });
  const apps = await row(tree, "apps/");
  fireEvent.dragOver(apps, { dataTransfer });
  expect(dataTransfer.dropEffect).toBe("none");
  fireEvent.drop(apps, { dataTransfer });
  expect(await screen.findAllByText(/Files can't be dragged between checkouts/)).not.toHaveLength(
    0,
  );
  expect(await row(tree, "README.md")).toBeTruthy();
  expect(await bytes({ client }, "README.md")).toBe(before);
  await expand(tree, ["apps/"]);
  expect(tree.querySelector('[data-path="apps/README.md"]')).toBeNull();
});
