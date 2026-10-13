import { InteractionRequest } from "@ace/protocol";
import { expect, it } from "vitest";
import { permissionDecisionOption } from "./index.ts";

const request = (kinds: readonly string[]) =>
  InteractionRequest.parse({
    kind: "approval",
    title: "Run ace_browser_evaluate",
    options: kinds.map((kind) => ({ id: kind, label: kind, kind })),
  });

it("an automatic refusal answers with the provider's deny", () => {
  expect(permissionDecisionOption(request(["allow_once", "deny", "cancel"]), "deny")?.kind).toBe(
    "deny",
  );
});

it("an automatic refusal never answers with cancel, which providers report as the person cancelling", () => {
  // No one-shot deny: the request is left for the person rather than cancelled in their name.
  expect(permissionDecisionOption(request(["allow_once", "cancel"]), "deny")).toBeUndefined();
});
