import { marketPublishFixture } from "@ace/fake-daemon";
import { configure, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { entry, findMarket, openApp } from "./market-test-seed.ts";

/*
 * ace's own publisher is drawn as ace's logo wherever a publisher avatar is, decided from the
 * daemon's official mark (the signed list), never from a name a publisher gave itself.
 */

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

const official = { id: "pub_ace", name: "ace" };
const lookalike = { id: "pub_x", name: "ace" };

/** The avatars in a region, as the logo draws them (an svg) and the plain ones (letters). */
const logos = (root: HTMLElement) =>
  root.querySelectorAll('[data-part="avatar"][data-variant="ace"] svg');
const initialsOf = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-part="avatar"]:not([data-variant])')].map(
    (avatar) => avatar.textContent,
  );

test("an entry page draws ace's logo for the official publisher, in its byline and under its facts", async () => {
  await openApp("/chats?market=skill/official", {
    entries: [
      {
        summary: entry("spade-skill", "official", "Official", { byAce: true, publisher: official }),
      },
    ],
  });
  const market = await findMarket();
  await within(market).findByRole("heading", { level: 1, name: "Official" });

  expect(logos(market).length).toBe(2);
  expect(initialsOf(market)).toEqual([]);
});

test("a publisher who named itself ace, without the signed list's mark, gets its letter, not the logo", async () => {
  await openApp("/chats?market=skill/lookalike", {
    entries: [
      { summary: entry("spade-skill", "lookalike", "Lookalike", { publisher: lookalike }) },
    ],
  });
  const market = await findMarket();
  await within(market).findByRole("heading", { level: 1, name: "Lookalike" });

  expect(logos(market).length).toBe(0);
  expect(initialsOf(market)).toEqual(["A", "A"]);
});

test("the official publisher's own page draws the logo in its head", async () => {
  const fixture = marketPublishFixture();
  const page = fixture.publishers?.[0];
  if (!page) throw new Error("the fixture has a publisher page");
  await openApp("/chats?market=skill/official", {
    entries: [
      {
        summary: entry("spade-skill", "official", "Official", { byAce: true, publisher: official }),
      },
    ],
    publishing: {
      ...fixture,
      publishers: [
        {
          ...page,
          profile: { ...page.profile, id: "pub_ace", handle: "ace", displayName: "ace" },
          pinned: [],
          entries: [
            entry("spade-skill", "official", "Official", { byAce: true, publisher: official }),
          ],
          official: true,
        },
      ],
    },
  });
  const market = await findMarket();
  await within(market).findByRole("heading", { level: 1, name: "Official" });
  const [byline] = within(market).getAllByRole("button", { name: "By ace" });
  if (!byline) throw new Error("the entry names its publisher");
  await userEvent.click(byline);
  await within(market).findByRole("heading", { level: 1, name: /^ace/ });

  const head = market.querySelector(".mk-profile-head") as HTMLElement;
  expect(logos(head).length).toBe(1);
  expect(initialsOf(head)).toEqual([]);
});

test("Discover's top publishers draw the logo only for the one the daemon marked official", async () => {
  const fixture = marketPublishFixture();
  const discover = fixture.discover;
  if (!discover) throw new Error("the fixture has Discover");
  await openApp("/chats?market=discover", {
    publishing: {
      ...fixture,
      discover: {
        ...discover,
        publishers: [
          {
            handle: "ace",
            displayName: "ace",
            verified: true,
            official: true,
            entries: 4,
            downloads: 900,
          },
          {
            handle: "ace-lookalike",
            displayName: "ace",
            verified: false,
            entries: 1,
            downloads: 9,
          },
        ],
      },
    },
  });
  const market = await findMarket();
  const cards = await within(market).findAllByText(/^@ace/);
  const [first, second] = cards.map((card) => card.closest("button") as HTMLElement);

  expect(logos(first as HTMLElement).length).toBe(1);
  expect(logos(second as HTMLElement).length).toBe(0);
  expect(initialsOf(second as HTMLElement)).toEqual(["A"]);
});
