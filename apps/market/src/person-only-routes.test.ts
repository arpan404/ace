import { expect, test } from "vitest";
import { personOnlyActions, personOnlyRoutes } from "@ace/marketplace/person-only";
import { matchRoute } from "./routes.ts";

/*
 * The requests the daemon makes for the actions only the person takes (`personMarketCall`), as
 * the market routes them: each lands on a route the shared table marks person-only, and every
 * route in the table is one of them. A route renamed here, or one the table misspells, fails.
 */
const requests: Record<keyof typeof personOnlyActions, [string, string][]> = {
  withdraw: [
    ["POST", "/v1/me/entries/suit/tarn/withdraw"],
    ["POST", "/v1/me/entries/suit/tarn/versions/1.0.0/withdraw"],
  ],
  transfer: [["POST", "/v1/me/entries/suit/tarn/transfer"]],
  transferAnswer: [
    ["POST", "/v1/me/transfers/trf_abcdefgh12/accept"],
    ["POST", "/v1/me/transfers/trf_abcdefgh12/decline"],
  ],
  changeHandle: [["PUT", "/v1/me/handle"]],
  deleteEntry: [["DELETE", "/v1/me/entries/suit/tarn"]],
  applyVerification: [["POST", "/v1/me/verification"]],
  checkVerification: [["POST", "/v1/me/verification/check"]],
};

test("every person-only action's market request lands on a route that needs the person's grant", () => {
  const reached = new Set<string>();
  for (const [action, calls] of Object.entries(requests))
    for (const [method, path] of calls) {
      const matched = matchRoute(method, path);
      if (!("route" in matched)) throw new Error(`${method} ${path} has no route`);
      expect(personOnlyRoutes.has(matched.route.kind), `${action}: ${matched.route.kind}`).toBe(
        true,
      );
      reached.add(matched.route.kind);
    }
  expect([...reached].toSorted()).toEqual([...personOnlyRoutes].toSorted());
});
