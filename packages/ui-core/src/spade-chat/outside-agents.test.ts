import { expect, test } from "vitest";
import { readSpadeOutsideAgent, readSpadeOutsideAgents } from "./index.ts";

/*
 * The person's outside A2A agents as every client reads them (ADR 0202 §5): signed only on
 * Spade's word that the card's signature held, with why when it didn't.
 */

test("an agent reads as signed only when Spade says its signature held", () => {
  const listed = readSpadeOutsideAgents({
    agents: [
      {
        id: "travel-desk",
        name: "Travel desk",
        address: "https://agents.example.com/.well-known/agent-card.json",
        signed: true,
        signature: "Signed by its publisher's key",
        skills: [{ id: "book", name: "Book" }],
      },
      {
        id: "other",
        name: "Other",
        signed: false,
        signature: "Not signed",
        unsigned_because: "its signature doesn't match the card",
      },
      // A client claim of signed without Spade's words is not believed.
      { id: "odd", signed: true, signature: "Trust me" },
      { name: "no id" },
    ],
  });
  expect(listed.map((a) => [a.id, a.signed, a.signature])).toEqual([
    ["travel-desk", true, "Signed by its publisher's key"],
    ["other", false, "Not signed"],
    ["odd", false, "Not signed"],
  ]);
  expect(listed[1]?.unsignedBecause).toBe("its signature doesn't match the card");
  expect(readSpadeOutsideAgents("nope")).toEqual([]);
  expect(readSpadeOutsideAgent({ agent: { id: "x" } })?.signature).toBe("Not signed");
});
