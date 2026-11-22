import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { one } from "./editor-test-dom.ts";
import { mountEditor, tab } from "./editor-test-support.tsx";

/*
 * Open editors rows keep the file's name whole and always show its folder: a narrow row clips the
 * folder in its middle ("…/wor…"), never drops it, and the full path stays in the tooltip.
 */

// The browser's measuring, at its boundary: rows report their size at once, and no text fits.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      report: () => void;
      constructor(report: () => void) {
        this.report = report;
      }
      observe() {
        this.report();
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    letterSpacing: "",
    measureText: () => ({ width: 1_000_000 }),
  } as Partial<CanvasRenderingContext2D> as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a row in no room still shows its folder, with the full path in its tooltip", async () => {
  await mountEditor(one([tab("apps/web/src/lib/workspace/places.ts")]));
  const rows = within(screen.getByRole("region", { name: "Open editors" }));
  const row = rows.getByTitle("apps/web/src/lib/workspace/places.ts");
  expect(row.textContent).toContain("places.ts");
  expect(row.textContent).toContain("apps/web/src/lib/workspace");
});
