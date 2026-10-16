import { expect, test } from "vitest";
import {
  filterSessionToolEnv,
  forwardedToolEnvKeys,
  maxForwardedToolEnvLength,
} from "./tool-env.ts";

test("allowlisted tool credentials survive filtering", () => {
  expect(
    filterSessionToolEnv({
      GH_TOKEN: "gho_session",
      GITHUB_TOKEN: "github_session",
      GH_HOST: "ghe.example.com",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      NPM_TOKEN: "npm_session",
    }),
  ).toEqual({
    GH_TOKEN: "gho_session",
    GITHUB_TOKEN: "github_session",
    GH_HOST: "ghe.example.com",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    NPM_TOKEN: "npm_session",
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
    }),
  ).toEqual({});
});

test("non-string, empty and oversized values are dropped", () => {
  expect(
    filterSessionToolEnv({
      GH_TOKEN: "",
      GITHUB_TOKEN: 42,
      NPM_TOKEN: "x".repeat(maxForwardedToolEnvLength + 1),
      __proto__: "polluted",
    }),
  ).toEqual({});
  expect(filterSessionToolEnv(undefined)).toEqual({});
  expect(filterSessionToolEnv("GH_TOKEN=abc")).toEqual({});
});

test("the allowlist stays small and intentional", () => {
  expect(forwardedToolEnvKeys).toEqual([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_HOST",
    "SSH_AUTH_SOCK",
    "NPM_TOKEN",
  ]);
});
