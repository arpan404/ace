import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { one } from "./editor-test-dom.ts";
import { mountEditor, tab } from "./editor-test-support.tsx";

/*
 * Open editors rows keep the file's name whole and always show its folder: a narrow row clips the
 * folder in its middle ("…/wor…"), never drops it, and the full path stays in the tooltip.
 */

test("a row in no room still shows its folder, with the full path in its tooltip", async () => {
  // jsdom lays nothing out, so every row has no room at all.
  await mountEditor(one([tab("apps/web/src/lib/workspace/places.ts")]));
  const rows = within(screen.getByRole("region", { name: "Open editors" }));
  const row = rows.getByTitle("apps/web/src/lib/workspace/places.ts");
  expect(row.textContent).toContain("places.ts");
  expect(row.textContent).toContain("apps/web/src/lib/workspace");
});
