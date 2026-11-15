import { act, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { SuitDetail } from "@ace/protocol/suits";
import { fakeSuit, fakeSuitLibrary } from "@/test/fake-suits.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const root = document.documentElement;
afterEach(() => {
  for (const name of ["data-theme", "data-suit", "data-scheme", "data-surface", "data-density"])
    root.removeAttribute(name);
});

/** A Suit as the daemon serves it over one socket's grant, at one version. */
const sample = (grant: string, contentHash = "hash-1"): SuitDetail => ({
  ...fakeSuit(
    { id: "sample-suit", base: "midnight", dark: { canvas: "#0a0f1e" } },
    { scene: true, contentHash },
  ),
  sceneUrl: `http://127.0.0.1:4242/v1/suits/sample-suit/${contentHash}/${grant}/scene.html`,
});

const frame = () => document.querySelector<HTMLIFrameElement>('iframe[title="Suit scene"]');
const shell = () => document.querySelector("[data-connection]");

async function open(library: ReturnType<typeof fakeSuitLibrary>) {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit: "sample-suit" }));
  await harness({ storage, suits: library.transport }).open("/settings/appearance");
  await waitFor(() => expect(frame()).not.toBeNull());
}

test("the applied Suit's scene runs behind the shell, sandboxed, and the shell lets it through", async () => {
  const library = fakeSuitLibrary([sample("grant-a")]);
  await open(library);
  expect(frame()?.getAttribute("src")).toBe(sample("grant-a").sceneUrl);
  expect(frame()?.getAttribute("sandbox")).toBe("allow-scripts");
  await waitFor(() => expect(shell()?.hasAttribute("data-suit-scene")).toBe(true));
});

test("after a reconnect the scene loads from the new daemon run's URL", async () => {
  const library = fakeSuitLibrary([sample("grant-a")]);
  await open(library);
  act(() => library.replace([sample("grant-b")], 2));
  await waitFor(() => expect(frame()?.getAttribute("src")).toBe(sample("grant-b").sceneUrl));
});

test("a scene that fails is off for that version of the Suit, whose colours stay, until it changes", async () => {
  const library = fakeSuitLibrary([sample("grant-a")]);
  await open(library);
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "error", message: "boom" },
        source: frame()?.contentWindow ?? null,
      }),
    );
  });
  await waitFor(() => expect(frame()).toBeNull());
  expect(root.getAttribute("data-suit")).toBe("sample-suit");
  await waitFor(() => expect(shell()?.hasAttribute("data-suit-scene")).toBe(false));

  // A reconnect brings a new URL but the same version: the scene stays off.
  act(() => library.replace([sample("grant-b")], 2));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sample-suit"));
  expect(frame()).toBeNull();

  // An edit to the Suit is a new version, and its scene gets another go.
  act(() => library.replace([sample("grant-b", "hash-2")], 2));
  await waitFor(() =>
    expect(frame()?.getAttribute("src")).toBe(sample("grant-b", "hash-2").sceneUrl),
  );
});

const region = (name: string) =>
  document.querySelector<HTMLIFrameElement>(`iframe[data-suit-scene-frame="${name}"]`);

test("each region's scene runs inside its own region, and one stopping leaves the others", async () => {
  const base = "http://127.0.0.1:4242/v1/suits/rainy/hash-1/grant-a/";
  const rainy: SuitDetail = {
    ...fakeSuit({ id: "rainy", dark: { canvas: "#0a0f1e" } }, { scene: true }),
    sceneUrls: { sidebar: `${base}rain.html`, header: `${base}strip.html` },
  };
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit: "rainy" }));
  await harness({ storage, suits: fakeSuitLibrary([rainy]).transport }).open(
    "/settings/appearance",
  );
  await waitFor(() => expect(region("sidebar")).not.toBeNull());
  await waitFor(() => expect(region("header")).not.toBeNull());
  const sidebar = region("sidebar");
  expect(sidebar?.getAttribute("src")).toBe(`${base}rain.html`);
  expect(sidebar?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(sidebar?.closest('[data-focus-region="sidebar"]')).not.toBeNull();
  expect(region("header")?.closest("header")).not.toBeNull();
  // No app scene was named, so nothing runs behind the whole window.
  expect(document.querySelector('iframe[data-scene-fill="window"]')).toBeNull();

  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "error", message: "boom" },
        source: sidebar?.contentWindow ?? null,
      }),
    );
  });
  await waitFor(() => expect(region("sidebar")).toBeNull());
  expect(region("header")).not.toBeNull();
});
