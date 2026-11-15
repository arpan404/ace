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

/** A Suit with both schemes, its own suit.css, labels and an ornament. */
const neon: SuitDetail = {
  ...fakeSuit({
    id: "neon",
    name: "Neon",
    light: { canvas: "#fdf4ff" },
    dark: { canvas: "#14001f" },
    labels: { "composer-placeholder": "Say the word" },
  }),
  css: `[data-suit="neon"] [data-part=thread-row][data-state=active]{border-left:3px solid #ff00aa}`,
  ornaments: { "sidebar-header": "<svg><title>NEON</title></svg>" },
};
/** Another Suit, dark only, with rules of its own. */
const moss: SuitDetail = {
  ...fakeSuit({ id: "moss", name: "Moss", dark: { canvas: "#0b140b" } }),
  css: `[data-suit="moss"] [data-part=composer]{border-radius:0}`,
};

/** Each miniature of `id` under `within`: its shadow root. */
const miniatures = (scope: HTMLElement, id: string) =>
  [...scope.querySelectorAll(`[data-suit-miniature="${id}"] [data-suit-preview]`)].map(
    (host) => host.shadowRoot,
  );

/** What a miniature draws with: every sheet in its shadow root. */
const sheet = (shadow: ShadowRoot | null | undefined) =>
  [...(shadow?.querySelectorAll("style") ?? [])].map((style) => style.textContent).join("\n");

async function appearanceWearing(suit: string) {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit }));
  await harness({ storage, suits: fakeSuitLibrary([neon, moss]).transport }).open(
    "/settings/appearance",
  );
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe(suit));
}

test("each Suit card is drawn as it looks: its parts, its own CSS, labels and ornaments", async () => {
  await appearanceWearing("neon");
  const list = document.body;
  await waitFor(() => expect(miniatures(list, "moss")).toHaveLength(1));
  const [mossRoot] = miniatures(list, "moss");
  const [neonRoot] = miniatures(list, "neon");
  // A small ace window of real parts, the open thread row among them.
  expect(neonRoot?.querySelector('[data-part="thread-row"][data-state="active"]')).not.toBeNull();
  expect(neonRoot?.querySelector('[data-part="composer-input"]')?.textContent).toBe("Say the word");
  expect(neonRoot?.querySelector('[data-ornament="sidebar-header"] title')?.textContent).toBe(
    "NEON",
  );
  // Each draws with its own Suit's rules only, in its own scope.
  expect(sheet(mossRoot)).toContain(`[data-suit="moss"] [data-part=composer]{border-radius:0}`);
  expect(sheet(mossRoot)).not.toContain("#ff00aa");
  expect(mossRoot?.querySelector("[data-suit]")?.getAttribute("data-suit")).toBe("moss");
  // Out of reach of the Suit on screen: the miniature is in a shadow root, which page rules
  // (`<html data-suit="neon">`) never cross into.
  expect(document.querySelector('[data-suit-miniature] [data-part="composer"]')).toBeNull();
});

test("the picked Suit's card draws it in the scheme on screen, and the mode cards in each scheme", async () => {
  await appearanceWearing("neon");
  const looks = screen.getByRole("radiogroup", { name: "Look" });
  const card = within(looks).getByRole("radio", { name: "Neon" });
  expect(card.getAttribute("aria-checked")).toBe("true");
  await waitFor(() => expect(miniatures(card, "neon")).toHaveLength(1));
  const [own] = miniatures(card, "neon");
  expect(own?.querySelector("[data-suit]")?.getAttribute("data-scheme")).toBe(
    root.getAttribute("data-scheme"),
  );

  const modes = screen.getByRole("radiogroup", { name: "Mode" });
  const schemes = (name: string) =>
    miniatures(within(modes).getByRole("radio", { name }), "neon").flatMap((shadow) =>
      [...(shadow?.querySelectorAll("[data-suit]") ?? [])].map((frame) =>
        frame.getAttribute("data-scheme"),
      ),
    );
  expect(schemes("System")).toEqual(["light", "dark"]);
  expect(schemes("Light")).toEqual(["light"]);
  expect(schemes("Dark")).toEqual(["dark"]);
});

test("a Suit with one scheme shows that scheme on every mode card", async () => {
  await appearanceWearing("moss");
  const modes = screen.getByRole("radiogroup", { name: "Mode" });
  const light = within(modes).getByRole("radio", { name: "Light" });
  await waitFor(() => expect(miniatures(light, "moss")).toHaveLength(1));
  const [shadow] = miniatures(light, "moss");
  expect(shadow?.querySelector("[data-suit]")?.getAttribute("data-scheme")).toBe("dark");
});
