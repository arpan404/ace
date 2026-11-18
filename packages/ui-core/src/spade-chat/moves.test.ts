import { expect, test } from "vitest";
import { parseSpadeArrival, parseSpadeMove, spadeArrivalLine, spadeMoveLine } from "./index.ts";

const move = (fields: Record<string, unknown>) =>
  parseSpadeMove({ id: "mv_1", to: { host: "h2", name: "Studio" }, ...fields });

const say = (fields: Record<string, unknown>) => {
  const parsed = move(fields);
  return parsed ? spadeMoveLine(parsed, "Research") : undefined;
};

test("a move reads as one sentence for where it is", () => {
  expect(say({ state: "packing" })).toBe("Getting Research ready to move to Studio.");
  expect(say({ state: "sending", sent: 12, total: 40 })).toBe(
    "Copying Research to Studio, 12 of 40.",
  );
  expect(say({ state: "sending", waiting: true })).toBe("Waiting for Studio to come online.");
  expect(say({ state: "committing", waiting: true })).toBe(
    "Waiting for Studio to finish the move.",
  );
  expect(say({ state: "failed", problem: "notes arrived with 1 rows where 2 were sent" })).toBe(
    "Couldn't move Research to Studio: notes arrived with 1 rows where 2 were sent. It's still here.",
  );
});

test("a move only Cancel can still stop says so", () => {
  expect(move({ state: "sending", can_cancel: true })?.canCancel).toBe(true);
  expect(move({ state: "committing" })?.canCancel).toBe(false);
  expect(parseSpadeMove({ state: "sending" })).toBeUndefined();
});

test("an arrival names everything that needs the person, and nothing when nothing does", () => {
  const arrival = parseSpadeArrival({
    from: { host: "h1", name: "Laptop" },
    routines_paused: 2,
    webhooks: 1,
    folders: ["/Users/sam/launch"],
    endpoints: ["Paid"],
    apps: ["gmail"],
    plugins: [],
    left: [],
  });
  expect(arrival && spadeArrivalLine(arrival)).toBe(
    "Moved from Laptop. 2 routines are paused until you resume them; 1 webhook has a new address; grant this folder again: /Users/sam/launch; add the endpoint Paid on this machine; connect gmail.",
  );
  const quiet = parseSpadeArrival({ from: { name: "Laptop" } });
  expect(quiet && spadeArrivalLine(quiet)).toBe("Moved from Laptop.");
  expect(parseSpadeArrival(null)).toBeUndefined();
});
