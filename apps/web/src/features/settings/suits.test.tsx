import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { fakeSuit, fakeSuitLibrary } from "@/test/fake-suits.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const root = document.documentElement;
afterEach(() => {
  for (const name of ["data-theme", "data-suit", "data-scheme", "data-surface", "data-density"])
    root.removeAttribute(name);
});

const sunset = fakeSuit({
  id: "sunset",
  name: "Sunset",
  description: "Neon pink over a violet dusk.",
  base: "midnight",
  dark: { canvas: "#1a0b2e", accent: "#ff3ea5" },
  shape: { density: "compact" },
});
const faint = fakeSuit(
  { id: "faint", name: "Faint", dark: { canvas: "#101010", muted: "#141414" } },
  {
    problems: [
      { scheme: "dark", check: "contrast", field: "muted", message: "Muted text is too faint" },
    ],
  },
);

const boot = (storage: ReturnType<typeof memoryKeyValue>) =>
  JSON.parse(storage.getItem("ace.boot-appearance") ?? "{}");

async function openAppearance(options: Parameters<typeof harness>[0]) {
  await harness(options).open("/settings/appearance");
  await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
}

test("using a Suit applies it on this device and the next load replays it", async () => {
  const storage = memoryKeyValue();
  const library = fakeSuitLibrary([sunset, faint]);
  await openAppearance({ storage, suits: library.transport });

  await userEvent.click(await screen.findByRole("button", { name: "Use Sunset" }));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));
  // A dark-only Suit draws dark, and its own density wins.
  expect(root.getAttribute("data-scheme")).toBe("dark");
  expect(root.getAttribute("data-density")).toBe("compact");
  expect(document.getElementById("ace-suit")?.textContent).toContain("--background:#1a0b2e");
  await waitFor(() => {
    expect(boot(storage)).toMatchObject({
      suit: { summary: { id: "sunset" } },
      suitScheme: "dark",
    });
    expect(boot(storage).css).toContain('[data-suit="sunset"][data-scheme="dark"]');
  });

  await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(root.hasAttribute("data-suit")).toBe(false));
  await waitFor(() => expect(boot(storage).suit).toBeUndefined());
});

test("a Suit that needs fixes says what, and can't be used", async () => {
  await openAppearance({ suits: fakeSuitLibrary([faint]).transport });
  const list = await screen.findByRole("list", { name: "What Faint needs fixed" });
  expect(within(list).getByText("Muted text is too faint (dark muted)")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Use Faint" })).toBeNull();
});

test("a picked Suit that later fails its checks falls back to the theme", async () => {
  const library = fakeSuitLibrary([sunset]);
  await openAppearance({ suits: library.transport });
  await userEvent.click(await screen.findByRole("button", { name: "Use Sunset" }));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));

  act(() =>
    library.replace([
      { ...sunset, summary: { ...sunset.summary, problems: faint.summary.problems } },
    ]),
  );
  await waitFor(() => expect(root.hasAttribute("data-suit")).toBe(false));
  expect(screen.getByText("Sunset needs fixes, so ace shows.")).toBeTruthy();
});

test("with Suits off this session the theme shows and none can be used", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit: "sunset" }));
  await openAppearance({ storage, suitsOff: true, suits: fakeSuitLibrary([sunset]).transport });
  expect(await screen.findByText("Suits are off for this session, so ace shows.")).toBeTruthy();
  expect(root.hasAttribute("data-suit")).toBe(false);
});

test("an agent's preview shows over the setting until it is kept or reverted", async () => {
  const storage = memoryKeyValue();
  const library = fakeSuitLibrary([sunset]);
  await openAppearance({ storage, suits: library.transport });
  await screen.findByRole("button", { name: "Use Sunset" });

  act(() => library.active({ suitId: "sunset", preview: true }));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));
  expect(screen.getByText(/An agent is previewing Sunset/)).toBeTruthy();
  expect(JSON.parse(storage.getItem("ace.appearance") ?? "{}").suit ?? null).toBeNull();

  act(() => library.active({ suitId: null, preview: false }));
  await waitFor(() => expect(root.hasAttribute("data-suit")).toBe(false));

  act(() => library.active({ suitId: "sunset", preview: false }));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));
  expect(JSON.parse(storage.getItem("ace.appearance") ?? "{}").suit).toBe("sunset");
});
