import { expect, it } from "vitest";
import { harness, required } from "./test-helper.ts";
import { genericQuirks } from "./quirks/generic.ts";
import { redactLease } from "./frame-redaction.ts";
import { encodeResolution, interactionRequest, validateResolution } from "./interactions.ts";

const secret = "lease-secret-0123456789";
const native = {
  sessionId: "root-session",
  toolCall: { toolCallId: "t", kind: "execute", title: "Run", rawInput: { command: "ls" } },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: `deny-${secret}`, name: "Deny", kind: "reject_once" },
  ],
};

it("an option whose id carried a lease secret is published by place and still answerable", () => {
  // The translator reads frames with lease secrets redacted, as the session publishes them.
  const published = redactLease(native, [secret]) as typeof native;
  const h = harness(genericQuirks);
  h.ready();
  h.frame("recv", { id: 9, method: "session/request_permission", params: published });
  const interaction = required(Object.values(h.state.interactions)[0]);
  const request = interaction.request;
  if (request.kind !== "approval") throw new Error("Expected an approval");
  const deny = required(request.options.find((option) => option.label === "Deny"));
  expect(deny.id).not.toContain("redacted");
  expect(request.options.find((option) => option.label === "Allow")?.id).toBe("allow");

  // The session validates against the same published request and answers with the native id.
  const sessionRequest = required(
    interactionRequest("session/request_permission", published, genericQuirks),
  );
  const validated = validateResolution(sessionRequest, { kind: "approval", optionId: deny.id });
  const answer = encodeResolution(
    "session/request_permission",
    { published, native },
    validated,
    sessionRequest,
  );
  expect(answer).toEqual({ outcome: { outcome: "selected", optionId: `deny-${secret}` } });

  // The agent's answer, as published (redacted), resolves to the option the person picked.
  h.frame("send", {
    id: 9,
    result: redactLease({ outcome: { outcome: "selected", optionId: `deny-${secret}` } }, [secret]),
  });
  expect(Object.values(h.state.interactions)[0]?.resolution).toEqual({
    kind: "approval",
    optionId: deny.id,
  });
  expect(required(h.tools()[0]).call.status).toBe("declined");
});
