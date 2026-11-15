import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { fakeSuit, fakeSuitLibrary } from "@/test/fake-suits.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { themeDeclarations } from "@/theme/css.ts";
import type { SuitTransport } from "@/theme/suits/suit-transport.ts";

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
const tarn = fakeSuit(
  { id: "tarn", name: "Tarn", light: { canvas: "#e7eaee" }, dark: { canvas: "#16181b" } },
  { scene: true },
);
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
const saved = (storage: ReturnType<typeof memoryKeyValue>) =>
  JSON.parse(storage.getItem("ace.appearance") ?? "{}");

async function openAppearance(options: Parameters<typeof harness>[0]) {
  await harness(options).open("/settings/appearance");
  await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
}

const looks = () => screen.getByRole("radiogroup", { name: "Look" });
const look = (name: string) => within(looks()).getByRole("radio", { name });
const motion = () => screen.queryByRole("group", { name: "Backdrop motion" });
const strip = () => document.querySelector('[data-variant="look-preview"]');
const picked = () =>
  within(looks())
    .getAllByRole("radio")
    .filter((radio) => radio.getAttribute("aria-checked") === "true")
    .map((radio) => radio.getAttribute("aria-label"));

test("themes and Suits are one set of looks, each Suit saying what it has", async () => {
  await openAppearance({ suits: fakeSuitLibrary([sunset, tarn]).transport });
  await screen.findByRole("radio", { name: "Tarn" });
  expect(
    within(looks())
      .getAllByRole("radio")
      .map((radio) => radio.getAttribute("aria-label")),
  ).toEqual(["ace", "Paper", "Midnight", "Grove", "Harbor", "Dusk", "Sunset", "Tarn"]);
  expect(look("Tarn").getAttribute("aria-description")).toBe("Scene");
  expect(look("Sunset").getAttribute("aria-description")).toBe(
    "Neon pink over a violet dusk. Dark only",
  );
  expect(picked()).toEqual(["ace"]);
  // The page says Look, not the format's name.
  expect(document.querySelector("main")?.textContent).not.toMatch(/Suit/);
});

test("picking a Suit card applies it on this device, the theme cards show unpicked, and the next load replays it", async () => {
  const storage = memoryKeyValue();
  await openAppearance({ storage, suits: fakeSuitLibrary([sunset, faint]).transport });

  await userEvent.click(await screen.findByRole("radio", { name: "Sunset" }));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));
  expect(picked()).toEqual(["Sunset"]);
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
});

test("picking a theme turns the Suit off", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit: "sunset" }));
  await openAppearance({ storage, suits: fakeSuitLibrary([sunset]).transport });
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));

  await userEvent.click(look("Paper"));
  await waitFor(() => expect(root.hasAttribute("data-suit")).toBe(false));
  expect(root.getAttribute("data-theme")).toBe("paper");
  expect(picked()).toEqual(["Paper"]);
  expect(saved(storage).suit).toBeNull();
  await waitFor(() => expect(boot(storage).suit).toBeUndefined());
});

test("Accent is for themes: with a Suit picked it says the Suit sets its own colours", async () => {
  await openAppearance({ suits: fakeSuitLibrary([sunset]).transport });
  expect(await screen.findByRole("radiogroup", { name: "Accent" })).toBeTruthy();

  await userEvent.click(await screen.findByRole("radio", { name: "Sunset" }));
  await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Accent" })).toBeNull());
  expect(screen.getByText("Sunset sets its own colours.")).toBeTruthy();

  await userEvent.click(look("ace"));
  expect(await screen.findByRole("radiogroup", { name: "Accent" })).toBeTruthy();
});

test("Backdrop motion shows only for a look with a scene, and is kept on this device", async () => {
  const storage = memoryKeyValue();
  await openAppearance({ storage, suits: fakeSuitLibrary([sunset, tarn]).transport });
  await screen.findByRole("radio", { name: "Tarn" });
  expect(motion()).toBeNull();

  await userEvent.click(look("Sunset"));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));
  expect(motion()).toBeNull();

  await userEvent.click(look("Tarn"));
  await waitFor(() => expect(motion()).not.toBeNull());
  await userEvent.click(within(motion() as HTMLElement).getByRole("button", { name: "Reduced" }));
  expect(saved(storage).backdropMotion).toBe("reduced");

  await userEvent.click(look("Grove"));
  await waitFor(() => expect(motion()).toBeNull());
  expect(saved(storage).backdropMotion).toBe("reduced");
});

test("a Suit that needs fixes is dimmed, can't be picked, and says what under its name", async () => {
  await openAppearance({ suits: fakeSuitLibrary([faint]).transport });
  const card = await screen.findByRole("radio", { name: "Faint" });
  expect(card.hasAttribute("disabled")).toBe(true);
  expect(card.getAttribute("data-state")).toBe("disabled");
  await userEvent.click(card);
  expect(root.hasAttribute("data-suit")).toBe(false);
  expect(picked()).toEqual(["ace"]);

  // One short line, which opens to the whole list.
  await userEvent.click(screen.getByText("Needs fixes: Muted text is too faint"));
  const list = screen.getByRole("list", { name: "What Faint needs fixed" });
  expect(within(list).getByText("Muted text is too faint (dark muted)")).toBeTruthy();
  // A Suit can style the problems as failed rows (docs/design/suit-parts.md).
  expect(list.getAttribute("data-part")).toBe("list");
  const rows = within(list).getAllByRole("listitem");
  expect(rows.map((row) => row.getAttribute("data-state"))).toEqual(rows.map(() => "failed"));
});

test("a picked Suit that later fails its checks falls back to the theme, and says so", async () => {
  const library = fakeSuitLibrary([sunset]);
  await openAppearance({ suits: library.transport });
  await userEvent.click(await screen.findByRole("radio", { name: "Sunset" }));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));

  act(() =>
    library.replace([
      { ...sunset, summary: { ...sunset.summary, problems: faint.summary.problems } },
    ]),
  );
  await waitFor(() => expect(root.hasAttribute("data-suit")).toBe(false));
  expect(screen.getByText("Sunset needs fixes, so ace shows.")).toBeTruthy();
  expect(picked()).toEqual(["ace"]);
});

test("with Suits off this session the theme shows, none can be picked, and one line says why", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit: "sunset" }));
  await openAppearance({ storage, suitsOff: true, suits: fakeSuitLibrary([sunset]).transport });
  expect(
    await screen.findByText("Custom looks are off for this session, so ace shows."),
  ).toBeTruthy();
  expect(root.hasAttribute("data-suit")).toBe(false);
  expect(look("Sunset").hasAttribute("disabled")).toBe(true);
  expect(picked()).toEqual(["ace"]);
});

test("an agent's preview shows a strip: Keep makes it this device's look", async () => {
  const storage = memoryKeyValue();
  const library = fakeSuitLibrary([sunset]);
  await openAppearance({ storage, suits: library.transport });
  await screen.findByRole("radio", { name: "Sunset" });
  expect(screen.queryByText(/An agent is previewing/)).toBeNull();

  act(() => library.active({ kind: "preview", suitId: "sunset" }));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));
  expect(await screen.findByText(/An agent is previewing/)).toBeTruthy();
  expect(strip()?.textContent).toContain("An agent is previewing Sunset.");
  expect(saved(storage).suit ?? null).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Keep" }));
  expect(screen.queryByText(/An agent is previewing/)).toBeNull();
  expect(saved(storage).suit).toBe("sunset");
  expect(root.getAttribute("data-suit")).toBe("sunset");
  expect(picked()).toEqual(["Sunset"]);
});

test("Revert ends an agent's preview and this device's own look comes back", async () => {
  const storage = memoryKeyValue();
  const library = fakeSuitLibrary([sunset]);
  await openAppearance({ storage, suits: library.transport });
  await screen.findByRole("radio", { name: "Sunset" });

  act(() => library.active({ kind: "preview", suitId: "sunset" }));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));
  await userEvent.click(await screen.findByRole("button", { name: "Revert" }));
  await waitFor(() => expect(root.hasAttribute("data-suit")).toBe(false));
  expect(screen.queryByText(/An agent is previewing/)).toBeNull();
  expect(saved(storage).suit ?? null).toBeNull();
  expect(picked()).toEqual(["ace"]);
});

test("an agent's own keep and none land on this device as before", async () => {
  const storage = memoryKeyValue();
  const library = fakeSuitLibrary([sunset]);
  await openAppearance({ storage, suits: library.transport });
  await screen.findByRole("radio", { name: "Sunset" });

  act(() => library.active({ kind: "preview", suitId: "sunset" }));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));
  act(() => library.active({ kind: "none" }));
  await waitFor(() => expect(root.hasAttribute("data-suit")).toBe(false));

  act(() => library.active({ kind: "keep", suitId: "sunset", keepId: "k1" }));
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("sunset"));
  expect(saved(storage).suit).toBe("sunset");
});

test("reverting a keep puts back this device's own look, unless the person changed it since", async () => {
  const storage = memoryKeyValue();
  const library = fakeSuitLibrary([sunset]);
  await openAppearance({ storage, suits: library.transport });
  await screen.findByRole("radio", { name: "Sunset" });
  const setting = () => saved(storage).suit ?? null;

  act(() => library.active({ kind: "keep", suitId: "sunset", keepId: "k1" }));
  await waitFor(() => expect(setting()).toBe("sunset"));
  act(() => library.active({ kind: "restore", keepId: "k1" }));
  await waitFor(() => expect(setting()).toBeNull());
  await waitFor(() => expect(root.hasAttribute("data-suit")).toBe(false));

  // A second keep, then the person picks a theme themselves: the undo leaves that be.
  act(() => library.active({ kind: "keep", suitId: "sunset", keepId: "k2" }));
  await waitFor(() => expect(setting()).toBe("sunset"));
  await userEvent.click(look("ace"));
  await waitFor(() => expect(setting()).toBeNull());
  act(() => library.active({ kind: "restore", keepId: "k2" }));
  expect(setting()).toBeNull();
});

test("a Suit that tries to set status colours still renders ace's own status tokens", async () => {
  const loud = fakeSuit({
    id: "loud",
    base: "midnight",
    // Not fields a Suit may set: kept as raw data by the schema, never applied.
    dark: { canvas: "#1a0b2e", working: "#00ff00", failed: "#00ff00", waiting: "#00ff00" },
  });
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit: "loud" }));
  await openAppearance({ storage, suits: fakeSuitLibrary([loud]).transport });
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("loud"));
  const sheet = document.getElementById("ace-suit")?.textContent ?? "";
  expect(sheet).toContain("--background:#1a0b2e");
  expect(sheet).not.toContain("#00ff00");
  const midnight = themeDeclarations("midnight", "dark");
  for (const name of ["--status-working", "--status-failed", "--status-waiting", "--danger"])
    expect(sheet).toContain(`${name}:${midnight[name]}`);
});

test("Make your own opens a new thread with the make-a-suit skill named first", async () => {
  await openAppearance({ suits: fakeSuitLibrary([]).transport });
  const make = await screen.findByRole("link", { name: "Make your own" });
  expect(make.getAttribute("href")).toBe("/new?skill=make-a-suit");
  await userEvent.click(make);
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  const field = await screen.findByRole("combobox", { name: "Message" });
  expect(field.textContent).toBe("/make-a-suit ");
});

test("while the library loads the looks hold placeholders; if it can't be read, one quiet line", async () => {
  let fail: (() => void) | undefined;
  const slow: SuitTransport = {
    ...fakeSuitLibrary([]).transport,
    watch: (_receive, failed) => {
      fail = failed;
      return () => {};
    },
  };
  await openAppearance({ suits: slow });
  expect(within(looks()).getAllByRole("radio")).toHaveLength(6);
  expect(looks().querySelectorAll(".bg-skel").length).toBeGreaterThan(0);

  act(() => fail?.());
  expect(await screen.findByText("Your own looks couldn't be read.")).toBeTruthy();
  expect(looks().querySelectorAll(".bg-skel")).toHaveLength(0);
  expect(screen.getByRole("link", { name: "Make your own" })).toBeTruthy();
});
