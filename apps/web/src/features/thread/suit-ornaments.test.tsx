import { longHistory } from "@ace/fake-daemon";
import type { SuitDetail } from "@ace/protocol/suits";
import { configure, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fakeSuit, fakeSuitLibrary } from "@/test/fake-suits.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const name of ["data-theme", "data-suit", "data-scheme", "data-surface", "data-density"])
    document.documentElement.removeAttribute(name);
});

const plate = `<svg viewBox="0 0 10 2"><rect width="10" height="2" fill="#ff0"></rect></svg>`;

async function open(suit: SuitDetail | undefined) {
  const storage = memoryKeyValue();
  if (suit) storage.setItem("ace.appearance", JSON.stringify({ suit: suit.summary.id }));
  const app = harness({ storage, suits: fakeSuitLibrary(suit ? [suit] : []).transport });
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-router");
  await screen.findByRole("combobox", { name: "Message" });
  if (suit)
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-suit")).toBe(suit.summary.id),
    );
}

const ornament = (slot: string) => document.querySelector(`[data-ornament="${slot}"]`);

test("a Suit's ornaments show in their slots as decoration nobody can reach", async () => {
  await open({
    ...fakeSuit({ id: "hazard", dark: { canvas: "#101014" } }),
    ornaments: {
      "transcript-top": plate,
      "composer-top": plate,
      "sidebar-footer": plate,
      "corner-top-right": plate,
    },
  });
  for (const slot of ["transcript-top", "composer-top", "sidebar-footer", "corner-top-right"]) {
    const element = await waitFor(() => {
      const found = ornament(slot);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(element.getAttribute("aria-hidden")).toBe("true");
    expect(element.hasAttribute("inert")).toBe(true);
    expect(element.className).toContain("pointer-events-none");
    expect(element.querySelector("rect")).not.toBeNull();
  }
  // The composer's sits above its surface in the flow, never inside or over it.
  const composer = document.querySelector('[data-slot="composer"]');
  const top = ornament("composer-top");
  if (!composer || !top) throw new Error("the composer and its ornament should both be there");
  expect(composer.contains(top)).toBe(false);
  expect(top.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("without a Suit no slot renders anything", async () => {
  await open(undefined);
  expect(document.querySelector("[data-ornament]")).toBeNull();
});
