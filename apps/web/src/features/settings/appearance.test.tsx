import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const root = document.documentElement;
afterEach(() => {
  for (const name of ["data-theme", "data-scheme", "data-accent", "data-density", "style"])
    root.removeAttribute(name);
});

function systemPrefers(dark: boolean) {
  return (query: string) =>
    ({
      matches: query.includes("dark") ? dark : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

test("picking a theme applies it at once and survives a reload", async () => {
  const storage = memoryKeyValue();
  const first = await harness({ storage }).open("/settings/appearance");
  expect(root.getAttribute("data-theme")).toBe("dark");

  await userEvent.click(await screen.findByRole("radio", { name: "Midnight" }));
  expect(root.getAttribute("data-theme")).toBe("midnight");
  expect(screen.getByRole("radio", { name: "Midnight" }).getAttribute("aria-checked")).toBe("true");
  // index.html replays this before first paint on the next load.
  await waitFor(() =>
    expect(JSON.parse(storage.getItem("ace.boot-theme") ?? "{}")).toMatchObject({
      theme: "midnight",
      attributes: { "data-theme": "midnight", "data-scheme": "dark" },
    }),
  );

  first.unmount();
  root.removeAttribute("data-theme");
  await harness({ storage }).open("/settings/appearance");
  await waitFor(() => expect(root.getAttribute("data-theme")).toBe("midnight"));
});

test("System follows the operating system's light or dark preference", async () => {
  await harness({ matchMedia: systemPrefers(false) }).open("/settings/appearance");
  await userEvent.click(await screen.findByRole("radio", { name: "System" }));
  expect(root.getAttribute("data-theme")).toBe("light");
  expect(root.getAttribute("data-scheme")).toBe("light");
});

test("a first visit follows the OS: light on a light system, dark on a dark one", async () => {
  const light = await harness({ matchMedia: systemPrefers(false) }).open("/settings/appearance");
  expect(root.getAttribute("data-theme")).toBe("light");
  expect(root.getAttribute("data-scheme")).toBe("light");
  expect((await screen.findByRole("radio", { name: "System" })).getAttribute("aria-checked")).toBe(
    "true",
  );
  // The browser's own bar takes the page's background.
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toMatch(/^#/);
  light.unmount();

  await harness({ matchMedia: systemPrefers(true) }).open("/settings/appearance");
  expect(root.getAttribute("data-theme")).toBe("dark");
});

test("themes and accents are radio groups: arrow keys move and choose", async () => {
  await harness().open("/settings/appearance");
  const system = await screen.findByRole("radio", { name: "System" });
  system.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(root.getAttribute("data-theme")).toBe("light");
  expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Light" }));

  const blue = screen.getByRole("radio", { name: "Blue" });
  expect(blue.getAttribute("tabindex")).toBe("0");
  expect(screen.getByRole("radio", { name: "Violet" }).getAttribute("tabindex")).toBe("-1");
  blue.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(root.getAttribute("data-accent")).toBe("violet");
});

test("a custom accent hex becomes the ring colour; status colours are untouched", async () => {
  await harness().open("/settings/appearance");
  const hex = await screen.findByRole("textbox", { name: "Custom accent hex" });
  expect((hex as HTMLInputElement).value).toBe("#7AA2F7");
  await userEvent.clear(hex);
  await userEvent.type(hex, "#ff88");
  await userEvent.tab();
  expect(hex.getAttribute("aria-invalid")).toBe("true");
  await userEvent.clear(hex);
  await userEvent.type(hex, "#ff8800");
  expect(root.getAttribute("data-accent")).toBe("custom");
  expect(root.style.getPropertyValue("--accent-custom")).toBe("#ff8800");
  expect(root.style.getPropertyValue("--status-working")).toBe("");
});

test("density and glass apply to the document", async () => {
  await harness().open("/settings/appearance");
  await userEvent.click(await screen.findByRole("button", { name: "Compact" }));
  expect(root.getAttribute("data-density")).toBe("compact");

  const glass = screen.getByRole("slider", { name: "Glass intensity" });
  glass.focus();
  await userEvent.keyboard("{Home}");
  expect(root.style.getPropertyValue("--glass")).toBe("0");
});
