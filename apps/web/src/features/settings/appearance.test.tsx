import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { deltaE, parseOpaqueColor, rgbToOklch, type Rgb } from "@/theme/colour.ts";
import { themes } from "@/theme/palettes.ts";

const root = document.documentElement;
const glassCss = readFileSync(join(import.meta.dirname, "../../styles/glass.css"), "utf8");
afterEach(() => {
  for (const name of [
    "data-theme",
    "data-scheme",
    "data-surface",
    "data-reduce-motion",
    "data-density",
    "data-glass-engine",
    "style",
  ])
    root.removeAttribute(name);
});

interface Prefers {
  dark?: boolean;
  reducedMotion?: boolean;
  reducedTransparency?: boolean;
}
function system(prefers: Prefers) {
  return (query: string) =>
    ({
      matches:
        (query.includes("color-scheme: dark") && Boolean(prefers.dark)) ||
        (query.includes("reduced-motion") && Boolean(prefers.reducedMotion)) ||
        (query.includes("reduced-transparency") && Boolean(prefers.reducedTransparency)),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

/** Waits for the route's focus move to the title, so a click's focus isn't taken back. */
async function settled() {
  await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
}

test("picking a theme applies it at once and the next load replays it before first paint", async () => {
  const storage = memoryKeyValue();
  const first = await harness({ storage, matchMedia: system({}) }).open("/settings/appearance");
  expect(root.getAttribute("data-theme")).toBe("ace");
  await settled();

  await userEvent.click(screen.getByRole("radio", { name: "Umbra" }));
  expect(root.getAttribute("data-theme")).toBe("umbra");
  expect(screen.getByRole("radio", { name: "Umbra" }).getAttribute("aria-checked")).toBe("true");
  // index.html replays this record before the app's script runs.
  await waitFor(() => {
    const boot = JSON.parse(storage.getItem("ace.boot-appearance") ?? "{}");
    expect(boot).toMatchObject({ theme: "umbra", mode: "system" });
    expect(boot.css).toContain('[data-theme="umbra"][data-scheme="dark"]');
  });

  first.unmount();
  root.removeAttribute("data-theme");
  await harness({ storage }).open("/settings/appearance");
  await waitFor(() => expect(root.getAttribute("data-theme")).toBe("umbra"));
});

test("mode is separate from theme: System follows the OS and Dark keeps the theme", async () => {
  await harness({ matchMedia: system({ dark: false }) }).open("/settings/appearance");
  expect(root.getAttribute("data-scheme")).toBe("light");
  // The browser's own bar takes the page's background.
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
    themes.ace.light.s0,
  );
  await settled();
  await userEvent.click(screen.getByRole("radio", { name: "Folio" }));
  await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(root.getAttribute("data-scheme")).toBe("dark");
  expect(root.getAttribute("data-theme")).toBe("folio");
});

test("the mode cards set the mode, the chosen one is the checked radio, and System follows the OS", async () => {
  await harness({ matchMedia: system({ dark: true }) }).open("/settings/appearance");
  const modes = await screen.findByRole("radiogroup", { name: "Mode" });
  expect(within(modes).getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(root.getAttribute("data-scheme")).toBe("dark");
  await settled();

  await userEvent.click(within(modes).getByRole("radio", { name: "Light" }));
  expect(root.getAttribute("data-scheme")).toBe("light");
  const checked = within(modes)
    .getAllByRole("radio")
    .filter((radio) => radio.getAttribute("aria-checked") === "true");
  expect(checked.map((radio) => radio.getAttribute("aria-label"))).toEqual(["Light"]);

  // Arrow keys move the choice like any radio group.
  await userEvent.keyboard("{ArrowRight}");
  expect(root.getAttribute("data-scheme")).toBe("dark");
  expect(document.activeElement).toBe(within(modes).getByRole("radio", { name: "Dark" }));
});

test("the mode cards preview whichever theme is on, System in both schemes", async () => {
  await harness({ matchMedia: system({}) }).open("/settings/appearance");
  await settled();
  await userEvent.click(screen.getByRole("radio", { name: "Harbor" }));
  const modes = screen.getByRole("radiogroup", { name: "Mode" });
  const drawn = (name: string) =>
    [...within(modes).getByRole("radio", { name }).querySelectorAll("[data-theme]")].map(
      (node) => `${node.getAttribute("data-theme")} ${node.getAttribute("data-scheme")}`,
    );
  expect(drawn("System")).toEqual(["harbor light", "harbor dark"]);
  expect(drawn("Light")).toEqual(["harbor light"]);
  expect(drawn("Dark")).toEqual(["harbor dark"]);
});

test("only the active theme is a checked radio, and choosing another moves it", async () => {
  await harness({ matchMedia: system({}) }).open("/settings/appearance");
  await settled();
  const group = screen.getByRole("radiogroup", { name: "Theme" });
  const checked = () =>
    within(group)
      .getAllByRole("radio")
      .filter((radio) => radio.getAttribute("aria-checked") === "true")
      .map((radio) => radio.getAttribute("aria-label"));
  expect(checked()).toEqual(["ace"]);
  await userEvent.click(within(group).getByRole("radio", { name: "Umbra" }));
  expect(checked()).toEqual(["Umbra"]);
  expect(within(group).getByRole("radio", { name: "Umbra" }).getAttribute("tabindex")).toBe("0");
});

test("the theme swatches can be changed by keyboard", async () => {
  await harness().open("/settings/appearance");
  const ace = await screen.findByRole("radio", { name: "ace" });
  expect(ace.getAttribute("tabindex")).toBe("0");
  await settled();
  ace.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(root.getAttribute("data-theme")).toBe("folio");
  expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Folio" }));
});

test("ace is the default theme, and its accent is the ink: Send and focus take the text colour", async () => {
  await harness({ matchMedia: system({ dark: true }) }).open("/settings/appearance");
  expect(root.getAttribute("data-theme")).toBe("ace");
  // The ink: a neutral grey a hair from the text colour, not a hue.
  expect(rgbToOklch(colour("--ring")).c).toBeLessThan(0.002);
  expect(deltaE(colour("--ring"), colour("--foreground"))).toBeLessThan(2);
  const accent = await screen.findByRole("radiogroup", { name: "Accent" });
  const own = within(accent).getByRole("radio", { name: "ace default" });
  expect(own.getAttribute("aria-checked")).toBe("true");
});

test("Settings offers the six themes with ace first, each previewed in its own tokens", async () => {
  await harness({ matchMedia: system({}) }).open("/settings/appearance");
  const group = await screen.findByRole("radiogroup", { name: "Theme" });
  const radios = within(group).getAllByRole("radio");
  expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
    "ace",
    "Folio",
    "Umbra",
    "Signal",
    "Tty",
    "Harbor",
  ]);
  // Each card draws its own theme, whatever theme the app is in, with the rules the app itself
  // uses: the preview's canvas is the theme's.
  const folio = within(group).getByRole("radio", { name: "Folio" });
  const previews = [...folio.querySelectorAll("[data-theme]")].map(
    (node) => `${node.getAttribute("data-theme")} ${node.getAttribute("data-scheme")}`,
  );
  expect(previews).toEqual(["folio light"]);
  const sheet = document.getElementById("ace-themes")?.textContent ?? "";
  const selector = `[data-theme="folio"][data-scheme="light"]{`;
  const body = sheet.slice(sheet.indexOf(selector) + selector.length).split("}")[0] ?? "";
  expect(body).toContain(`--background:${themes.folio.light.s0}`);
});

test("the theme cards preview each theme in the mode on screen and follow a mode change", async () => {
  await harness({ matchMedia: system({}) }).open("/settings/appearance");
  await settled();
  const group = screen.getByRole("radiogroup", { name: "Theme" });
  const drawn = () =>
    within(group)
      .getAllByRole("radio")
      .map((card) =>
        [...card.querySelectorAll("[data-theme]")].map(
          (node) => `${node.getAttribute("data-theme")} ${node.getAttribute("data-scheme")}`,
        ),
      );
  expect(drawn()).toEqual([
    ["ace light"],
    ["folio light"],
    ["umbra light"],
    ["signal light"],
    ["tty light"],
    ["harbor light"],
  ]);
  await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(drawn()).toEqual([
    ["ace dark"],
    ["folio dark"],
    ["umbra dark"],
    ["signal dark"],
    ["tty dark"],
    ["harbor dark"],
  ]);
});

/** The value the page's stylesheet gives `name` for the theme and scheme on <html>. */
function token(name: string): string | undefined {
  const sheet = document.getElementById("ace-themes")?.textContent ?? "";
  const selector = `[data-theme="${root.getAttribute("data-theme")}"][data-scheme="${root.getAttribute("data-scheme")}"]{`;
  const body = sheet.slice(sheet.indexOf(selector) + selector.length).split("}")[0] ?? "";
  return new RegExp(`(?:^|;)${name}:([^;]+)`).exec(body)?.[1];
}

/** `token(name)` as a colour. */
function colour(name: string): Rgb {
  const parsed = parseOpaqueColor(token(name));
  if (!parsed) throw new Error(`${name} is not a colour`);
  return parsed;
}

test("an accent applies over any theme, survives a theme switch and replays on the next load", async () => {
  const storage = memoryKeyValue();
  const first = await harness({ storage, matchMedia: system({}) }).open("/settings/appearance");
  await settled();
  const themeOwn = token("--ring");
  const accent = screen.getByRole("radiogroup", { name: "Accent" });

  await userEvent.click(within(accent).getByRole("radio", { name: "Violet" }));
  const violet = token("--ring");
  expect(violet).not.toBe(themeOwn);
  await userEvent.click(screen.getByRole("radio", { name: "Folio" }));
  expect(within(accent).getByRole("radio", { name: "Violet" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(token("--ring")).not.toBe(themes.folio.light.accent);

  // Ink is the theme's own text colour.
  await userEvent.click(within(accent).getByRole("radio", { name: "Ink" }));
  expect(token("--ring")).toBe(themes.folio.light.t1);
  await waitFor(() => {
    const boot = JSON.parse(storage.getItem("ace.boot-appearance") ?? "{}");
    expect(boot.css).toContain(`--ring:${themes.folio.light.t1}`);
  });
  first.unmount();
  await harness({ storage, matchMedia: system({}) }).open("/settings/appearance");
  await waitFor(() => expect(token("--ring")).toBe(themes.folio.light.t1));
});

test("a custom accent takes a typed hex, and one on top of a status colour is moved clear", async () => {
  await harness({ matchMedia: system({}) }).open("/settings/appearance");
  await settled();
  await userEvent.click(screen.getByRole("radio", { name: "Custom accent" }));
  const hex = await screen.findByRole("textbox", { name: "Custom accent hex" });
  await userEvent.clear(hex);
  const working = themes.ace.light.working;
  await userEvent.type(hex, working);
  // The working blue itself: the accent shifts off it and says so.
  expect(token("--ring")).not.toBe(working);
  expect(token("--status-working")).toBe(working);
  expect(screen.getByText("Shifted to stay clear of status colours")).toBeTruthy();
});

/**
 * The floating material as the browser cascades it (styles/glass.css), on a real menu-like layer.
 * jsdom doesn't apply rules inside `@layer`, so the layer wrapper is lifted off.
 */
function floatingLayer() {
  const style = document.createElement("style");
  style.textContent = glassCss.replace(
    /@layer components \{([\s\S]*)\}\s*(@keyframes[\s\S]*)$/,
    "$1\n$2",
  );
  document.head.append(style);
  const layer = document.createElement("div");
  layer.className = "ace-floating";
  document.body.append(layer);
  onTestFinished(() => {
    style.remove();
    layer.remove();
  });
  return () => getComputedStyle(layer).getPropertyValue("backdrop-filter");
}

const slider = () => screen.getByRole("slider", { name: "Translucency" }) as HTMLInputElement;

test("Translucency at Solid leaves floating layers with no backdrop filter at all", async () => {
  await harness({ matchMedia: system({}) }).open("/settings/appearance");
  const backdrop = floatingLayer();
  expect(root.getAttribute("data-surface")).toBe("translucent");
  expect(backdrop()).toMatch(/blur\(/);
  await settled();

  slider().focus();
  await userEvent.keyboard("{Home}");
  expect(slider().getAttribute("aria-valuetext")).toBe("Solid");
  expect(root.getAttribute("data-surface")).toBe("solid");
  expect(backdrop()).toMatch(/^(none)?$/);
});

test("arrow keys move the slider and the floating layers follow live, and it's kept", async () => {
  const storage = memoryKeyValue();
  await harness({ storage, matchMedia: system({}) }).open("/settings/appearance");
  await settled();
  // The default is the theme's own glass, the most translucent end.
  expect(slider().getAttribute("aria-valuetext")).toBe("100%");
  const tint = () => root.style.getPropertyValue("--glass-tint");
  const blur = () => root.style.getPropertyValue("--glass-blur");
  const before = { tint: tint(), blur: blur() };

  slider().focus();
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
  expect(slider().getAttribute("aria-valuetext")).toBe("70%");
  expect(screen.getByText("70%")).toBeTruthy();
  // A thicker tint and a softer blur, applied to the page at once.
  expect(tint()).not.toBe(before.tint);
  expect(Number.parseFloat(blur())).toBeLessThan(Number.parseFloat(before.blur));
  expect(root.getAttribute("data-surface")).toBe("translucent");
  await userEvent.keyboard("{ArrowRight}");
  expect(slider().getAttribute("aria-valuetext")).toBe("80%");
  expect(JSON.parse(storage.getItem("ace.appearance") ?? "{}").translucency).toBe(80);
  // The next load boots with the same glass.
  await waitFor(() => {
    const boot = JSON.parse(storage.getItem("ace.boot-appearance") ?? "{}");
    expect(boot).toMatchObject({ surface: "translucent", translucency: 80 });
    expect(boot.css).toContain(`--glass-tint:${tint()}`);
  });
});

test("Signal is always solid: the slider is disabled at Solid and says why", async () => {
  await harness({ matchMedia: system({}) }).open("/settings/appearance");
  await settled();
  await userEvent.click(screen.getByRole("radio", { name: "Signal" }));
  expect(root.getAttribute("data-surface")).toBe("solid");
  expect(slider().disabled).toBe(true);
  expect(slider().getAttribute("aria-valuetext")).toBe("Solid");
  expect(screen.getByText("Signal is always solid")).toBeTruthy();
  // The person's own setting is kept for the next theme with glass.
  await userEvent.click(screen.getByRole("radio", { name: "Harbor" }));
  expect(slider().disabled).toBe(false);
  expect(slider().getAttribute("aria-valuetext")).toBe("100%");
});

test("the OS reducing transparency forces Solid, and the slider shows it", async () => {
  await harness({ matchMedia: system({ reducedTransparency: true }) }).open("/settings/appearance");
  expect(root.getAttribute("data-surface")).toBe("solid");
  expect(await screen.findByText("Solid while your system reduces transparency")).toBeTruthy();
  expect(slider().disabled).toBe(true);
  expect(slider().getAttribute("aria-valuetext")).toBe("Solid");
});

test("someone who chose Solid surfaces before the slider opens at Solid", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ theme: "umbra", surface: "solid" }));
  await harness({ storage, matchMedia: system({}) }).open("/settings/appearance");
  expect(root.getAttribute("data-surface")).toBe("solid");
  await screen.findByRole("slider", { name: "Translucency" });
  expect(slider().getAttribute("aria-valuetext")).toBe("Solid");
  expect(slider().disabled).toBe(false);
});

test("Reduce motion follows the OS under System, and On or Off overrides it", async () => {
  await harness({ matchMedia: system({ reducedMotion: true }) }).open("/settings/appearance");
  expect(root.hasAttribute("data-reduce-motion")).toBe(true);
  await settled();
  await userEvent.click(screen.getByRole("button", { name: "Off" }));
  expect(root.hasAttribute("data-reduce-motion")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "On" }));
  expect(root.hasAttribute("data-reduce-motion")).toBe(true);
});

test("density applies to the document", async () => {
  await harness().open("/settings/appearance");
  const compact = await screen.findByRole("button", { name: "Compact" });
  await settled();
  await userEvent.click(compact);
  expect(root.getAttribute("data-density")).toBe("compact");
});
