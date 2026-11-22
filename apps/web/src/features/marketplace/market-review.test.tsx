import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { fakeSuit, fakeSuitLibrary } from "@/test/fake-suits.ts";
import { flaggedWord } from "./market-model.ts";
import { findMarket, openApp, seed } from "./market-test-seed.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

const harbour = seed.entries?.[0];
if (!harbour) throw new Error("the seed lists Harbour dusk first");

/** Harbour dusk's review, its body saying what the daemon found in its bytes. */
const suitWith = (body: Record<string, unknown>) => ({
  ...harbour,
  review: {
    body: {
      type: "suit" as const,
      passes: true,
      problems: [],
      scenes: [],
      fonts: [],
      files: 2,
      ...body,
    },
  },
  items: [
    ...(harbour.items ?? []),
    {
      kind: "file" as const,
      section: "",
      file: { path: "suit.json", bytes: 240, executable: false, flagged: false },
    },
  ],
});

test("a Suit's review leads with its look and a short list of facts, its files folded", async () => {
  await openApp("/chats?market=suit/harbour-dusk/review", {
    entries: [suitWith({ fonts: ["Tarn Sans", "Tarn Sans", "Tarn Mono"], files: 11 })],
  });
  const market = await findMarket();

  expect(
    await within(market).findByRole("heading", { level: 1, name: "Get Harbour dusk" }),
  ).toBeTruthy();
  expect(within(market).getByText("Dark only")).toBeTruthy();
  const facts = within(within(market).getByRole("list", { name: "What it is" }));
  expect(facts.getByText("Sets its fonts: Tarn Sans and Tarn Mono.")).toBeTruthy();
  expect(facts.getByText("11 files.")).toBeTruthy();
  // One version, the listing's.
  expect(within(market).getAllByText(/1\.0\.0/)).toHaveLength(1);

  // suit.json as it came sits folded with the file list until Show files opens it.
  const files = within(market)
    .getByText(/"format":1/)
    .closest("details");
  expect(files?.open).toBe(false);
  await userEvent.click(within(market).getByText("Show files"));
  expect(files?.open).toBe(true);
  expect(within(market).getByText("Hide files")).toBeTruthy();
});

test("a Suit already in this machine's library offers to wear it, not to install it", async () => {
  const library = fakeSuitLibrary([
    fakeSuit({ id: "harbour-dusk", name: "Harbour dusk", dark: { accent: "#E8B86A" } }),
  ]);
  await openApp("/chats?market=suit/harbour-dusk", {}, { suits: library.transport });
  const market = await findMarket();
  expect(await within(market).findByText("In your Suits")).toBeTruthy();
  expect(within(market).queryByRole("button", { name: /^(Get|Install)\b/ })).toBeNull();

  await userEvent.click(within(market).getByRole("button", { name: "Wear it" }));
  expect(await within(market).findByText("Wearing")).toBeTruthy();
});

test("its review says there's nothing to install and offers Wear it", async () => {
  const library = fakeSuitLibrary([fakeSuit({ id: "harbour-dusk", dark: {} })]);
  await openApp("/chats?market=suit/harbour-dusk/review", {}, { suits: library.transport });
  const market = await findMarket();

  expect(
    await within(market).findByText(
      "Harbour dusk is already in your Suits, so there's nothing to install.",
    ),
  ).toBeTruthy();
  expect(within(market).getByRole("button", { name: "Wear it" })).toBeTruthy();
  expect(within(market).queryByRole("button", { name: /^(Get|Install)\b/ })).toBeNull();
});

test("Installed carries no count while the marketplace installed nothing", async () => {
  await openApp("/chats?market=discover");
  const market = await findMarket();
  expect((await within(market).findAllByRole("button", { name: "Installed" })).length).toBe(1);
  expect(within(market).queryByRole("button", { name: /^Installed \d/ })).toBeNull();
});

test("an install that wants a fresh sign-in says so and offers to sign in, never only red", async () => {
  const { daemon } = await openApp("/chats?market=skill/triage-mail/review");
  daemon.marketplace.refuseInstall = {
    op: "error",
    code: "reauth",
    message: "Sign in again to do this.",
  };
  const market = await findMarket();
  await userEvent.click(await within(market).findByRole("button", { name: "Get" }));

  const page = await screen.findByRole("region", { name: "Marketplace" });
  const said = await within(page).findByRole("status");
  expect(said.textContent).toContain("Installing needs a recent sign-in to your ace account.");
  // A build without an ace account sends the person to sign in under Profile.
  expect(within(said).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
    "/settings/profile",
  );
  expect(within(market).queryByRole("alert")).toBeNull();
});

test.each([
  [{ path: "scripts/run.sh", executable: true, flagged: true }, "A script or program"],
  [{ path: "assets/fonts/Mono.woff2", executable: false, flagged: true }, "Font"],
  [{ path: "assets/thumbnail-dark.webp", executable: false, flagged: true }, "Picture"],
  [{ path: "scene.js", executable: false, flagged: true }, "Code"],
  [{ path: "suit.css", executable: false, flagged: false }, undefined],
])("a reviewed file %o reads as %s", (file, word) => {
  expect(flaggedWord(file)).toBe(word);
});

test("the review is titled with the entry's name, its crumb saying Review", async () => {
  await openApp("/chats?market=skill/triage-mail/review");
  const market = await findMarket();
  expect(
    await within(market).findByRole("heading", { level: 1, name: "Get Triage mail" }),
  ).toBeTruthy();
  expect(
    within(within(market).getByRole("navigation", { name: "Back" })).getByText("Review"),
  ).toBeTruthy();
  await waitFor(() => expect(screen.queryByText("Review Triage mail")).toBeNull());
});
