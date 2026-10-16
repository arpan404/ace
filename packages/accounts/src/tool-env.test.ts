import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import {
  filterSessionToolEnv,
  maxForwardedToolEnvLength,
  withSubmittedToolEnv,
} from "./tool-env.ts";

test("allowlisted tool credentials survive filtering", () => {
  expect(
    filterSessionToolEnv({
      GH_TOKEN: "gho_session",
      GITHUB_TOKEN: "github_session",
      GH_HOST: "ghe.example.com",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    }),
  ).toEqual({
    GH_TOKEN: "gho_session",
    GITHUB_TOKEN: "github_session",
    GH_HOST: "ghe.example.com",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
  });
});

test("non-allowlisted variables never reach provider processes", () => {
  expect(
    filterSessionToolEnv({
      PATH: "/evil",
      LD_PRELOAD: "/evil.so",
      HOME: "/evil",
      CODEX_HOME: "/evil",
      OPENAI_API_KEY: "ambient",
      ACE_MCP_BEARER_TOKEN: "bearer",
      NPM_TOKEN: "unlisted",
    }),
  ).toEqual({});
});

test("non-string, empty and oversized values are dropped", () => {
  expect(
    filterSessionToolEnv({
      GH_TOKEN: "",
      GITHUB_TOKEN: 42,
      GH_HOST: "x".repeat(maxForwardedToolEnvLength + 1),
    }),
  ).toEqual({});
  expect(filterSessionToolEnv(undefined)).toEqual({});
  expect(filterSessionToolEnv("GH_TOKEN=abc")).toEqual({});
});

test("an own __proto__ property cannot smuggle a value through", () => {
  const input = JSON.parse('{"__proto__":"polluted","GH_TOKEN":"gho_session"}');
  expect(Object.entries(input)).toContainEqual(["__proto__", "polluted"]);
  expect(filterSessionToolEnv(input)).toEqual({ GH_TOKEN: "gho_session" });
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
});

test("vault entries win over session values without mutating either", () => {
  const session = { threadId: ThreadId.parse("thread-1"), toolEnv: { GH_TOKEN: "ambient" } };
  expect(withSubmittedToolEnv(session, { get: () => undefined }, () => true)).toBe(session);
  const merged = withSubmittedToolEnv(
    session,
    { get: (id: string) => (id === "thread-1" ? { GH_TOKEN: "submitted" } : undefined) },
    () => true,
  );
  expect(merged).toEqual({ threadId: "thread-1", toolEnv: { GH_TOKEN: "submitted" } });
  expect(session.toolEnv).toEqual({ GH_TOKEN: "ambient" });
});
