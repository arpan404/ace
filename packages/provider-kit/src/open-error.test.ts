import { expect, it } from "vitest";
import { SessionOpenError } from "@ace/provider-kit/open-error";

it("open failures retain readable messages despite malformed optional provider fields", () => {
  const failure = new SessionOpenError("Provider session opening failed", {
    code: 42,
    title: null,
    message: "Could not open the project directory",
  });
  expect(failure.message).toContain("Could not open the project directory");
  expect(failure.detail).toBe("Could not open the project directory");
});

it("open failures scrub environment credentials and bound detail without retaining a raw cause", () => {
  const secret = "private-environment-value";
  const native = Object.assign(new Error(`failed with ${secret}`), {
    code: "invalid_model",
    title: "Cannot select model",
    detail: `failed with ${secret}; Bearer abcdef012345; api_key=hidden ${"x".repeat(5000)}`,
  });
  const failure = new SessionOpenError("Provider session opening failed", native, {
    env: { API_KEY: secret },
  });
  expect(failure).toMatchObject({ code: "invalid_model", title: "Cannot select model" });
  expect(failure.detail).toContain("failed with <ENV>");
  expect(failure.detail.length).toBe(2048);
  expect(failure.message.length).toBeLessThanOrEqual(2306);
  const diagnostic = `${failure.message} ${JSON.stringify(failure)}`;
  for (const value of [secret, "abcdef012345", "hidden"]) expect(diagnostic).not.toContain(value);
  expect(failure.cause).toBeUndefined();
});
