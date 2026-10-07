import { smoothnessMeasurements } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

/** The finished turn's work log, opened: one row per measurement. */
async function openSteps() {
  const app = harness();
  app.play(smoothnessMeasurements()).runThrough("measured");
  await app.open("/t/thread-smoothness");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(await within(feed).findByRole("button", { name: /^Worked for/ }));
  return within(feed).findByRole("list", { name: "Steps" });
}

/** Opens the row of the measurement that did `measured` ("Scrolled in Safari"); its card. */
async function openCard(steps: HTMLElement, measured: string) {
  const row = new RegExp(`^Measured smoothness: ${measured.replace("+", "\\+")} `);
  await userEvent.click(await within(steps).findByRole("button", { name: row }));
  return within(steps).getByRole("region", { name: `Smoothness: ${measured}` });
}

test("each measurement reads as one line with its verdict and key number", async () => {
  const steps = await openSteps();
  const rows = [
    "Measured smoothness: Scrolled in Safari Smooth · 0.8 ms/s hitching",
    "Measured smoothness: Clicked in the browser tab Minor hitches · 7.4 ms/s hitching",
    "Measured smoothness: Pressed command+K in TextEdit Janky · 25 ms/s hitching",
    "Measured smoothness: Pressed Escape in the browser tab No visible change",
    "Measured smoothness: Watched Safari Inconclusive",
  ];
  for (const name of rows) expect(await within(steps).findByRole("button", { name })).toBeTruthy();
  // Collapsed: no card until a row is opened.
  expect(within(steps).queryByRole("region", { name: /^Smoothness: / })).toBeNull();
});

test("a measurement opens to its numbers, its timeline and its filmstrip", async () => {
  const steps = await openSteps();
  const card = await openCard(steps, "Scrolled in Safari");
  expect(within(card).getByText("Smooth")).toBeTruthy();
  const numbers = Object.fromEntries(
    within(card)
      .getAllByRole("term")
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
  );
  expect(numbers).toEqual({
    Response: "18 ms",
    Settled: "640 ms",
    Active: "119 fps of 120 Hz",
    Hitching: "0.8 ms/s",
  });
  expect(
    within(card).getByRole("img", {
      name: "Input at 0 ms, first change at 18 ms, 0 hitches, settled at 640 ms, 2,000 ms recorded",
    }),
  ).toBeTruthy();
  // Confident: nothing to qualify the verdict.
  expect(within(card).queryByText(/confidence/)).toBeNull();

  await userEvent.click(within(card).getByRole("button", { name: "Filmstrip" }));
  const lightbox = await screen.findByRole("dialog", { name: "Filmstrip" });
  expect(within(lightbox).getByRole("img", { name: "Filmstrip" }).getAttribute("src")).toMatch(
    /^data:image\/jpeg;base64,/,
  );
});

test("a janky run lists each hitch for assistive tech", async () => {
  const steps = await openSteps();
  const card = await openCard(steps, "Pressed command+K in TextEdit");
  expect(within(card).getByText("Janky")).toBeTruthy();
  const hitches = within(card).getByRole("list", { name: "Hitches" });
  expect(
    within(hitches)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Hitch at 120 ms, 180 ms long", "Hitch at 600 ms, 66 ms long"]);
  expect(
    within(card).getByRole("img", { name: /^Input at 0 ms, first change at 95 ms, 2 hitches,/ }),
  ).toBeTruthy();
});

test("repeated runs show median · worst and each run's verdict", async () => {
  const steps = await openSteps();
  const row = await within(steps).findByRole("button", {
    name: /^Measured smoothness: Scrolled in the browser tab/,
  });
  // The verdict is the worst run's, so the row says how many runs it was.
  expect(row.textContent).toContain("Minor hitches in 1 of 3 runs · 1.2 · 6.2 ms/s hitching");
  const card = await openCard(steps, "Scrolled in the browser tab");
  expect(within(card).getByText("18 · 25 ms")).toBeTruthy();
  expect(within(card).getByText("59 · 54 fps of 60 Hz")).toBeTruthy();
  expect(within(card).getByText("3 runs, median · worst")).toBeTruthy();
  const runs = within(card).getByRole("list", { name: "Runs" });
  expect(
    within(runs)
      .getAllByRole("img")
      .map((run) => run.getAttribute("aria-label")),
  ).toEqual(["Run 1: smooth", "Run 2: minor hitches", "Run 3: smooth"]);
});

test("a low-confidence result says why, with the tool's notes one click away and no filmstrip", async () => {
  const steps = await openSteps();
  const card = await openCard(steps, "Dragged in Safari");
  expect(within(card).getByText("Low confidence: host was busy")).toBeTruthy();
  expect(within(card).queryByRole("list", { name: "Notes" })).toBeNull();

  await userEvent.click(within(card).getByRole("button", { name: "2 notes" }));
  const notes = within(card).getByRole("list", { name: "Notes" });
  expect(notes.textContent).toContain("Host one-minute load exceeds logical cores");
  // This result came back without a filmstrip, and still settles nothing it can't show.
  expect(within(card).queryByRole("button", { name: "Filmstrip" })).toBeNull();
  expect(
    within(card).getByRole("img", { name: /, 1 hitch, still changing when recording ended,/ }),
  ).toBeTruthy();
});

test("no visible change and an inconclusive watch say so without inventing numbers", async () => {
  const steps = await openSteps();
  const still = await openCard(steps, "Pressed Escape in the browser tab");
  expect(within(still).getByText("No visible change")).toBeTruthy();
  expect(within(still).queryAllByRole("term")).toHaveLength(0);
  expect(
    within(still).getByRole("img", {
      name: "Input at 0 ms, no visible change, 2,000 ms recorded",
    }),
  ).toBeTruthy();
  expect(within(still).getByText("Low confidence: too few frames")).toBeTruthy();

  const watched = await openCard(steps, "Watched Safari");
  expect(within(watched).getByText("Inconclusive")).toBeTruthy();
  expect(within(watched).queryAllByRole("term")).toHaveLength(0);
  expect(
    within(watched).getByRole("img", {
      name: "Recording from 0 ms, 0 hitches, still changing when recording ended, 2,000 ms recorded",
    }),
  ).toBeTruthy();
});
