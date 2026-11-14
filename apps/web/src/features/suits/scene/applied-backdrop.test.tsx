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

/** Starfield as the daemon serves it over one socket's grant, at one version. */
const starfield = (grant: string, contentHash = "hash-1"): SuitDetail => ({
  ...fakeSuit(
    { id: "starfield", base: "midnight", dark: { canvas: "#0a0f1e" } },
    { scene: true, contentHash },
  ),
  sceneUrl: `http://127.0.0.1:4242/v1/suits/starfield/${contentHash}/${grant}/scene.html`,
});

const frame = () => document.querySelector<HTMLIFrameElement>('iframe[title="Suit scene"]');
const shell = () => document.querySelector("[data-connection]");

async function open(library: ReturnType<typeof fakeSuitLibrary>) {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit: "starfield" }));
  await harness({ storage, suits: library.transport }).open("/settings/appearance");
  await waitFor(() => expect(frame()).not.toBeNull());
}

test("the applied Suit's scene runs behind the shell, sandboxed, and the shell lets it through", async () => {
  const library = fakeSuitLibrary([starfield("grant-a")]);
  await open(library);
  expect(frame()?.getAttribute("src")).toBe(starfield("grant-a").sceneUrl);
  expect(frame()?.getAttribute("sandbox")).toBe("allow-scripts");
  await waitFor(() => expect(shell()?.hasAttribute("data-suit-scene")).toBe(true));
});

test("after a reconnect the scene loads from the new daemon run's URL", async () => {
  const library = fakeSuitLibrary([starfield("grant-a")]);
  await open(library);
  act(() => library.replace([starfield("grant-b")], 2));
  await waitFor(() => expect(frame()?.getAttribute("src")).toBe(starfield("grant-b").sceneUrl));
});

test("a scene that fails is off for that version of the Suit, whose colours stay, until it changes", async () => {
  const library = fakeSuitLibrary([starfield("grant-a")]);
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
  expect(root.getAttribute("data-suit")).toBe("starfield");
  await waitFor(() => expect(shell()?.hasAttribute("data-suit-scene")).toBe(false));

  // A reconnect brings a new URL but the same version: the scene stays off.
  act(() => library.replace([starfield("grant-b")], 2));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("starfield"));
  expect(frame()).toBeNull();

  // An edit to the Suit is a new version, and its scene gets another go.
  act(() => library.replace([starfield("grant-b", "hash-2")], 2));
  await waitFor(() =>
    expect(frame()?.getAttribute("src")).toBe(starfield("grant-b", "hash-2").sceneUrl),
  );
});
