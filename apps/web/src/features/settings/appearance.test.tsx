import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { contrastRatio, parseOpaqueColor } from "@/theme/contrast.ts";

async function chooseTheme(name: string) {
  await userEvent.click(await screen.findByRole("combobox", { name: "Theme" }));
  await userEvent.click(await screen.findByRole("option", { name }));
}
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

  await chooseTheme("Midnight");
  expect(root.getAttribute("data-theme")).toBe("midnight");
  expect(screen.getByRole("combobox", { name: "Theme" }).textContent).toContain("Midnight");
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
  await chooseTheme("System");
  expect(root.getAttribute("data-theme")).toBe("light");
  expect(root.getAttribute("data-scheme")).toBe("light");
});

test("a first visit follows the OS: light on a light system, dark on a dark one", async () => {
  const light = await harness({ matchMedia: systemPrefers(false) }).open("/settings/appearance");
  expect(root.getAttribute("data-theme")).toBe("light");
  expect(root.getAttribute("data-scheme")).toBe("light");
  expect((await screen.findByRole("combobox", { name: "Theme" })).textContent).toContain("System");
  // The browser's own bar takes the page's background.
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toMatch(/^#/);
  light.unmount();

  await harness({ matchMedia: systemPrefers(true) }).open("/settings/appearance");
  expect(root.getAttribute("data-theme")).toBe("dark");
});

test("the theme picker and accent swatches can be changed by keyboard", async () => {
  await harness().open("/settings/appearance");
  const system = await screen.findByRole("combobox", { name: "Theme" });
  // A navigation moves focus to the view's title a frame after it renders (app-shell's route
  // focus); start from there, as a keyboard user would, so that move can't take focus back.
  await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  system.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("option", { name: "Light" });
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(root.getAttribute("data-theme")).toBe("light");
  expect(document.activeElement).toBe(system);

  // By default the accent is the theme's own, and that swatch takes Tab.
  const own = screen.getByRole("radio", { name: "Theme's own" });
  expect(own.getAttribute("tabindex")).toBe("0");
  expect(screen.getByRole("radio", { name: "Blue" }).getAttribute("tabindex")).toBe("-1");
  own.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(root.getAttribute("data-accent")).toBe("blue");
});

test("a custom accent hex becomes the ring colour; status colours are untouched", async () => {
  await harness().open("/settings/appearance");
  await userEvent.click(await screen.findByRole("radio", { name: /^Custom colour/ }));
  const hex = await screen.findByRole("textbox", { name: "Custom accent hex" });
  expect((hex as HTMLInputElement).value).toBe("#7AA2F7");
  await userEvent.clear(hex);
  await userEvent.type(hex, "#ff88");
  await userEvent.tab();
  expect(hex.getAttribute("aria-invalid")).toBe("true");
  await userEvent.clear(hex);
  await userEvent.type(hex, "#ff8800");
  expect(root.getAttribute("data-accent")).toBe("custom");
  expect(root.style.getPropertyValue("--ring")).toBe("#ff8800");
  expect(root.style.getPropertyValue("--status-working")).toBe("");
});

const ring = () => root.style.getPropertyValue("--ring");

test("by default the accent follows the theme; a pinned accent stays through a theme change", async () => {
  await harness().open("/settings/appearance");
  const dark = ring();
  await chooseTheme("Paper");
  const paper = ring();
  expect(paper).not.toBe(dark);

  await userEvent.click(screen.getByRole("radio", { name: "Violet" }));
  const violet = ring();
  expect(violet).not.toBe(paper);
  await chooseTheme("Light");
  await chooseTheme("Paper");
  expect(ring()).toBe(violet);
});

test("a white custom accent on Light keeps links and button labels readable", async () => {
  await harness().open("/settings/appearance");
  await chooseTheme("Light");
  await userEvent.click(screen.getByRole("radio", { name: /^Custom colour/ }));
  const hex = screen.getByRole("textbox", { name: "Custom accent hex" });
  await userEvent.clear(hex);
  await userEvent.type(hex, "#ffffff");
  const style = (name: string) => {
    const value = parseOpaqueColor(root.style.getPropertyValue(name));
    if (!value) throw new Error(`${name} is not a colour`);
    return value;
  };
  expect(root.style.getPropertyValue("--ring")).toBe("#ffffff");
  // Links on the white reading column, labels on a white button.
  expect(contrastRatio(style("--ring-text"), [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(style("--ring-foreground"), style("--ring"))).toBeGreaterThanOrEqual(4.5);
});

test("density and glass apply to the document", async () => {
  await harness().open("/settings/appearance");
  const compact = await screen.findByRole("button", { name: "Compact" });
  // Let the route's focus move to the title land first (see the radio-group test).
  await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  await userEvent.click(compact);
  expect(root.getAttribute("data-density")).toBe("compact");

  const glass = screen.getByRole("slider", { name: "Glass intensity" });
  glass.focus();
  await userEvent.keyboard("{Home}");
  expect(root.style.getPropertyValue("--glass")).toBe("0");
});
