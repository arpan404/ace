import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { WebLink, WebLinkOpener } from "./web-link.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

function linkIn(opened: string[] | undefined, href: string) {
  const link = <WebLink href={href}>Open</WebLink>;
  render(
    opened ? <WebLinkOpener value={(url) => void opened.push(url)}>{link}</WebLinkOpener> : link,
  );
  return screen.getByRole("link", { name: "Open" });
}

test("a link clicked on a screen with ace's browser opens there, not in a new tab", async () => {
  const opened: string[] = [];
  const tab = vi.spyOn(window, "open").mockReturnValue(null);
  await userEvent.click(linkIn(opened, "https://example.com/docs"));
  expect(opened).toEqual(["https://example.com/docs"]);
  expect(tab).not.toHaveBeenCalled();
});

test("a link with ⌘ and Ctrl held opens in the system's browser", async () => {
  const opened: string[] = [];
  const tab = vi.spyOn(window, "open").mockReturnValue(null);
  const user = userEvent.setup();
  const link = linkIn(opened, "https://example.com/docs");
  // Both held, so the platform's own modifier is among them whichever platform runs the test.
  await user.keyboard("{Meta>}{Control>}");
  await user.click(link);
  await user.keyboard("{/Control}{/Meta}");
  expect(opened).toEqual([]);
  expect(tab.mock.calls[0]?.[0]).toBe("https://example.com/docs");
});

test("a local address opens in ace's browser even with ⌘ and Ctrl held", async () => {
  const opened: string[] = [];
  const tab = vi.spyOn(window, "open").mockReturnValue(null);
  const user = userEvent.setup();
  const link = linkIn(opened, "http://localhost:5173/");
  await user.keyboard("{Meta>}{Control>}");
  await user.click(link);
  await user.keyboard("{/Control}{/Meta}");
  expect(opened).toEqual(["http://localhost:5173/"]);
  expect(tab).not.toHaveBeenCalled();
});

test("without ace's browser a link opens in the system's browser", async () => {
  const tab = vi.spyOn(window, "open").mockReturnValue(null);
  await userEvent.click(linkIn(undefined, "https://example.com/docs"));
  expect(tab.mock.calls[0]?.[0]).toBe("https://example.com/docs");
});
