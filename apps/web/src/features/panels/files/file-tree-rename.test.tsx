import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { bytes, expand, openExplorer, row, tabNames } from "./explorer-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

const relay = "apps/web/src/relay";

/** The explorer with relay/ open and socket.ts kept in a tab of its own. */
async function withSocketOpen() {
  const opened = await openExplorer();
  await expand(opened.tree, ["apps/", "apps/web/", "apps/web/src/", `${relay}/`]);
  await userEvent.dblClick(await row(opened.tree, `${relay}/socket.ts`));
  await within(opened.panel).findByRole("tab", { name: "socket.ts", selected: true });
  const tree = within(opened.panel).getByRole("tree", { name: "Checkout files" });
  return { ...opened, tree };
}

async function startRename(tree: HTMLElement, path: string) {
  (await row(tree, path)).focus();
  await userEvent.keyboard("{F2}");
  return within(tree).findByRole("textbox", { name: /^Rename / });
}

test("F2 renames a file in its row; the new row is selected and its open tab follows", async () => {
  const { app, panel, tree } = await withSocketOpen();
  const before = await bytes(app, `${relay}/socket.ts`);
  const field = await startRename(tree, `${relay}/socket.ts`);
  // The name's stem is selected, so typing replaces it and keeps the extension.
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect([
    (field as HTMLInputElement).selectionStart,
    (field as HTMLInputElement).selectionEnd,
  ]).toEqual([0, "socket".length]);
  await userEvent.keyboard("wire{Enter}");

  await within(panel).findByRole("tab", { name: "wire.ts", selected: true });
  expect(tabNames(panel)).not.toContain("socket.ts");
  expect(await bytes(app, `${relay}/wire.ts`)).toBe(before);
  const shown = within(panel).getByRole("tree", { name: "Checkout files" });
  const renamed = await row(shown, `${relay}/wire.ts`);
  await waitFor(() => expect(renamed.getAttribute("aria-selected")).toBe("true"));
  expect(shown.querySelector(`[data-path="${relay}/socket.ts"]`)).toBeNull();
});

test("renaming a folder keeps it open and selected, and tabs of files inside it follow", async () => {
  const { app, panel, tree } = await withSocketOpen();
  const field = await startRename(tree, `${relay}/`);
  await userEvent.clear(field);
  await userEvent.keyboard("transport{Enter}");

  const source = await within(panel).findByRole("region", {
    name: "Source of apps/web/src/transport/socket.ts",
  });
  await waitFor(() => expect(source.textContent).toContain("export class RelaySocket {"));
  expect(tabNames(panel)).toContain("socket.ts");
  const shown = within(panel).getByRole("tree", { name: "Checkout files" });
  const folder = await row(shown, "apps/web/src/transport/");
  await waitFor(() => expect(folder.getAttribute("aria-expanded")).toBe("true"));
  await row(shown, "apps/web/src/transport/outbox.ts");
  expect(await bytes(app, "apps/web/src/transport/outbox.ts")).toContain("export");
});

test("a name that is taken says so under the field; Escape keeps the old name", async () => {
  const { tree } = await withSocketOpen();
  const field = await startRename(tree, `${relay}/outbox.ts`);
  await userEvent.clear(field);
  await userEvent.keyboard("socket.ts{Enter}");
  expect((await within(tree).findByRole("alert")).textContent).toBe(
    "socket.ts already exists here. Choose another name.",
  );
  await userEvent.keyboard("{Escape}");
  expect(within(tree).queryByRole("textbox", { name: /^Rename / })).toBeNull();
  const kept = await row(tree, `${relay}/outbox.ts`);
  await waitFor(() => expect(document.activeElement).toBe(kept));
  expect(screen.queryByRole("dialog")).toBeNull();
});
