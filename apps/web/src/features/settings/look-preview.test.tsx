import type { SuitDetail } from "@ace/protocol/suits";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { fakeSuit, fakeSuitLibrary } from "@/test/fake-suits.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const root = document.documentElement;
afterEach(() => {
  for (const name of ["data-theme", "data-suit", "data-scheme", "data-surface", "data-density"])
    root.removeAttribute(name);
});

/** A Suit with both schemes, rounder corners and a still of its backdrop for dark only. */
const neon: SuitDetail = {
  ...fakeSuit({
    id: "neon",
    name: "Neon",
    base: "midnight",
    light: { canvas: "#fdf4ff" },
    dark: { canvas: "#14001f" },
    shape: { radius: 1.5 },
    thumbnail: { dark: "assets/dark.webp" },
  }),
  assets: { "assets/dark.webp": "http://daemon.test/v1/suits/neon/assets/dark.webp" },
};
/** Another Suit, dark only, with no still. */
const moss = fakeSuit({ id: "moss", name: "Moss", dark: { canvas: "#0b140b" } });

async function appearanceWearing(suit: string, mode: "light" | "dark" = "dark") {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit, mode }));
  await harness({ storage, suits: fakeSuitLibrary([neon, moss]).transport }).open(
    "/settings/appearance",
  );
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe(suit));
}

const card = (name: string) =>
  within(screen.getByRole("radiogroup", { name: "Look" })).getByRole("radio", { name });
/** Each scheme layer a card draws, with how it is scoped. */
const layers = (element: HTMLElement) =>
  [...element.querySelectorAll<HTMLElement>("[data-scheme]")].map((layer) => ({
    theme: layer.getAttribute("data-theme"),
    scheme: layer.getAttribute("data-scheme"),
    background: layer.style.getPropertyValue("--background"),
    radius: layer.style.getPropertyValue("--radius-scale"),
    backdrop: layer.querySelector<HTMLElement>(":scope > span[aria-hidden]")?.style.background,
  }));
/** A card's sketch as tag names, depth first: what a theme and a Suit must share. */
const shape = (element: Element): string =>
  `${element.tagName}(${[...element.children]
    .filter((child) => child.tagName !== "STYLE")
    .map(shape)
    .join(",")})`;

test("a Suit card is the same sketch as a theme card, in the Suit's own tokens", async () => {
  await appearanceWearing("neon");
  await waitFor(() => expect(card("Neon").querySelector("[data-look-preview]")).not.toBeNull());
  const suitSketch = card("Neon").querySelector("[data-look-preview]");
  const themeSketch = card("Midnight").querySelector("[data-look-preview]");
  if (!suitSketch || !themeSketch) throw new Error("no sketch");
  // Only the backdrop layer is extra: the window inside it is the theme card's, part for part.
  const [suitLayer] = suitSketch.querySelectorAll("[data-scheme]");
  const [themeLayer] = themeSketch.querySelectorAll("[data-scheme]");
  if (!suitLayer || !themeLayer) throw new Error("no layer");
  expect([...suitLayer.children].slice(1).map(shape)).toEqual([...themeLayer.children].map(shape));

  expect(layers(card("Neon"))).toEqual([
    expect.objectContaining({
      theme: "midnight",
      scheme: "dark",
      background: "#14001f",
      radius: "1.5",
    }),
  ]);
  // A theme card never takes the Suit's shape on the page through inheritance.
  expect(layers(card("Midnight"))[0]).toMatchObject({ theme: "midnight", radius: "1" });
});

test("a Suit's card shows its still for the scheme, else a gradient from its palette", async () => {
  await appearanceWearing("neon");
  await waitFor(() => expect(layers(card("Moss"))).toHaveLength(1));
  expect(layers(card("Neon"))[0]?.backdrop).toContain(
    "http://daemon.test/v1/suits/neon/assets/dark.webp",
  );
  expect(layers(card("Moss"))[0]?.backdrop).toContain("radial-gradient");
  expect(layers(card("Midnight"))[0]?.backdrop).toBeUndefined();
});

test("in light a Suit with only a dark still falls back to its gradient", async () => {
  await appearanceWearing("neon", "light");
  await waitFor(() => expect(layers(card("Neon"))).toHaveLength(1));
  expect(layers(card("Neon"))[0]).toMatchObject({ scheme: "light", background: "#fdf4ff" });
  expect(layers(card("Neon"))[0]?.backdrop).toContain("radial-gradient");
});

test("the mode cards draw the Suit on screen in each scheme, System in both", async () => {
  await appearanceWearing("neon");
  const modes = screen.getByRole("radiogroup", { name: "Mode" });
  const schemes = (name: string) =>
    layers(within(modes).getByRole("radio", { name })).map((layer) => layer.scheme);
  await waitFor(() => expect(schemes("System")).toEqual(["light", "dark"]));
  expect(schemes("Light")).toEqual(["light"]);
  expect(schemes("Dark")).toEqual(["dark"]);
  expect(layers(within(modes).getByRole("radio", { name: "Light" }))[0]?.background).toBe(
    "#fdf4ff",
  );
});

test("a Suit with one scheme shows that scheme on every mode card", async () => {
  await appearanceWearing("moss");
  const modes = screen.getByRole("radiogroup", { name: "Mode" });
  const light = within(modes).getByRole("radio", { name: "Light" });
  await waitFor(() => expect(layers(light)[0]?.scheme).toBe("dark"));
  expect(layers(light)[0]?.background).toBe("#0b140b");
});
