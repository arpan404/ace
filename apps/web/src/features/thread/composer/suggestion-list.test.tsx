import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { revealSuggestion, SuggestionList } from "./suggestion-list.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("active suggestions reveal only within their popup, without scrolling page ancestors", () => {
  const popup = document.createElement("div");
  popup.setAttribute("data-suggestions-popup", "");
  const item = document.createElement("div");
  popup.append(item);
  const scrollPage = vi.fn();
  Object.defineProperty(item, "scrollIntoView", { value: scrollPage });
  vi.spyOn(popup, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 200, 100));
  const bounds = vi
    .spyOn(item, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 200, 100, 36));
  revealSuggestion(item);
  expect(popup.scrollTop).toBe(40);
  bounds.mockReturnValue(new DOMRect(0, 80, 100, 36));
  revealSuggestion(item);
  expect(popup.scrollTop).toBe(16);
  bounds.mockReturnValue(new DOMRect(0, 120, 100, 36));
  revealSuggestion(item);
  expect(popup.scrollTop).toBe(16);
  expect(scrollPage).not.toHaveBeenCalled();
});

test("a tall list beside a centred composer stays above or below it, never to its side", async () => {
  // A 1200x500 window with the composer centred low in the main column: neither 420px above
  // nor below fits, but the empty sidebar area to its left would hold the whole list.
  const viewport = { width: 1200, height: 500 };
  const composerBox = new DOMRect(600, 200, 500, 100);
  const listBox = { width: 480, height: 420 };
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(viewport.width);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(viewport.height);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return isList(this) ? listBox.width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return isList(this) ? listBox.height : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.dataset.composer !== undefined) return composerBox;
    if (isList(this)) return new DOMRect(0, 0, listBox.width, listBox.height);
    return new DOMRect(0, 0, viewport.width, viewport.height);
  });

  const anchor = createRef<HTMLDivElement>();
  function Composer() {
    return (
      <>
        <div ref={anchor} data-composer="" />
        <SuggestionList
          id="mentions"
          anchor={anchor}
          onDismiss={() => {}}
          active={0}
          onPick={() => {}}
          suggestions={{
            state: "ready",
            kind: "mention",
            items: Array.from({ length: 12 }, (_, index) => ({
              insert: `file-${index}.ts`,
              label: `file-${index}.ts`,
              kind: "mention" as const,
              group: "Files",
            })),
          }}
        />
      </>
    );
  }
  render(<Composer />);

  const popup = await screen.findByRole("listbox", { name: "Mention" });
  const placed = popup.closest<HTMLElement>("[data-suggestions-popup]")?.parentElement;
  // Placement has been computed once the size pass has measured the room it was given.
  await waitFor(() => expect(placed?.getAttribute("style")).toContain("--available-height"));
  expect(["top", "bottom"]).toContain(placed?.dataset.side);
});

/** The list's positioner or popup, whose box Floating UI measures. */
function isList(element: HTMLElement): boolean {
  return (
    element.querySelector("[data-suggestions-popup]") !== null ||
    element.hasAttribute("data-suggestions-popup")
  );
}
