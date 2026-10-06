import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { StrictMode } from "react";
import { MenuItem } from "@/components/ui/menu.tsx";
import { deferredMenuButton } from "./deferred-menu-button.tsx";
import { HeaderMenuPopup } from "./menu-button-popup.tsx";
import { BootErrorBoundary } from "@/features/connect/index.ts";

const noop = () => {};

function coldMenu() {
  let release = noop;
  const loading = new Promise<typeof HeaderMenuPopup>((resolve) => {
    release = () => resolve(HeaderMenuPopup);
  });
  const ColdMenu = deferredMenuButton(() => loading);
  render(
    <StrictMode>
      <ColdMenu trigger={<button type="button">More actions</button>}>
        <MenuItem>First action</MenuItem>
        <MenuItem>Last action</MenuItem>
      </ColdMenu>
    </StrictMode>,
  );
  return async () =>
    act(async () => {
      release();
      await loading;
    });
}

test("a press before the menu loads opens it and Escape returns focus to its button", async () => {
  const release = coldMenu();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.queryByRole("menu")).toBeNull();
  await release();
  expect(await screen.findByRole("menuitem", { name: "First action" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "More actions" }));
});

test.each([
  ["ArrowDown", "First action"],
  ["ArrowUp", "Last action"],
  ["Enter", "First action"],
  [" ", "First action"],
])("%s pressed before the menu loads focuses %s", async (key, item) => {
  const release = coldMenu();
  const button = screen.getByRole("button", { name: "More actions" });
  button.focus();
  fireEvent.keyDown(button, { key });
  await release();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: item })),
  );
});

test("Escape while the menu loads cancels the pending open", async () => {
  const release = coldMenu();
  const button = screen.getByRole("button", { name: "More actions" });
  await userEvent.click(button);
  await userEvent.keyboard("{Escape}");
  await release();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(button);
});

test("a menu download failure reaches the app's reload screen", async () => {
  const UnavailableMenu = deferredMenuButton(async () => {
    throw new Error("Menu download failed");
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <BootErrorBoundary bare>
        <UnavailableMenu trigger={<button type="button">More actions</button>}>
          Actions
        </UnavailableMenu>
      </BootErrorBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("heading", { name: "ace couldn't start" })).toBeTruthy();
    expect(screen.getByText("Menu download failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  } finally {
    errors.mockRestore();
  }
});
