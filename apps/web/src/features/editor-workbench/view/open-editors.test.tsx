import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { one } from "./editor-test-dom.ts";
import { mountEditor, tab } from "./editor-test-support.tsx";

/*
 * Open editors rows keep the file's name whole and show as much of its folder as reads well:
 * the nearest folders, "…/" and the nearest, or its name cut at the end. With no room for four
 * of its letters the folder steps aside; the row's tooltip always has the full path.
 */

const path = "apps/web/src/lib/workspace/places.ts";
let room = 0;

// The browser's measuring, at its boundary: a row reports `room` px, each character is 7px.
beforeEach(() => {
  let report: (() => void) | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        report = callback;
      }
      observe() {
        report?.();
      }
      disconnect() {}
    },
  );
  const context = {
    font: "",
    letterSpacing: "",
    measureText: (text: string) => ({ width: [...text].length * 7 }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => room);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function folderShown(px: number): Promise<string> {
  room = px;
  await mountEditor(one([tab(path)]));
  await act(async () => {});
  const row = within(screen.getByRole("region", { name: "Open editors" })).getByTitle(path);
  expect(row.textContent).toContain("places.ts");
  return row.textContent?.replace("places.ts", "") ?? "";
}

test("a roomy row shows the whole folder", async () => {
  expect(await folderShown(400)).toBe("apps/web/src/lib/workspace");
});

test("a narrow row drops whole leading folders, keeping the nearest", async () => {
  expect(await folderShown(7 * 13)).toBe("lib/workspace");
});

test("a narrower row cuts the nearest folder's name at its end, never to one letter", async () => {
  expect(await folderShown(7 * 9)).toBe("…/worksp…");
});

test("a row with barely any room shows no folder, with the path still in its tooltip", async () => {
  expect(await folderShown(7 * 5)).toBe("");
});
