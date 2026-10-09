import { expect, test, vi } from "vitest";
import { revealSuggestion } from "./suggestion-list.tsx";

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
