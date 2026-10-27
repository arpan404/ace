import { expect, it } from "vitest";
import { CommandRunArgs, OutputTail, commandEnv, timeoutFor } from "./command-rules.ts";

it("a job's output pages through what is kept and says where earlier bytes went", () => {
  const tail = new OutputTail(10);
  tail.push(Buffer.from("0123456789"));
  tail.push(Buffer.from("abcdef"));
  expect(tail.total).toBe(16);
  expect(tail.start).toBe(6);
  // The latest page by default; an offset already dropped reads from the first kept byte.
  expect(tail.read(undefined, 4)).toEqual({ offset: 12, bytes: Buffer.from("cdef") });
  expect(tail.read(0, 4)).toEqual({ offset: 6, bytes: Buffer.from("6789") });
  expect(tail.read(10, 100)).toEqual({ offset: 10, bytes: Buffer.from("abcdef") });
  expect(tail.text()).toBe("[first 6 bytes dropped; the last 10 follow]\n6789abcdef");
});

it("a command never sees ace's own settings, and long waits must run in the background", () => {
  const env = commandEnv({ PATH: "/bin", ACE_HOME: "/secret", ace_token: "x" }, { CI: "1" });
  expect(Object.entries(env).filter(([, value]) => value !== undefined)).toEqual([["CI", "1"]]);
  expect(env).toMatchObject({ ACE_HOME: undefined, ace_token: undefined });
  expect(timeoutFor({ command: "make", timeoutSeconds: 900 })).toEqual({
    refused: expect.stringContaining("background: true"),
  });
  expect(timeoutFor({ command: "make", timeoutSeconds: 900, background: true })).toBe(900);
});

it("a command sees neither provider credentials nor anything that looks like a secret, and can't add them", () => {
  const base = {
    PATH: "/bin",
    HOME: "/Users/me",
    GIT_AUTHOR_NAME: "Me",
    TOKENIZERS_PARALLELISM: "false",
    ANTHROPIC_API_KEY: "a",
    ANTHROPIC_BASE_URL: "b",
    OPENAI_API_KEY: "c",
    OPENAI_ORG_ID: "d",
    GEMINI_API_KEY: "e",
    GITHUB_TOKEN: "f",
    NPM_CONFIG__AUTH: "g",
    CLAUDE_CODE_OAUTH_TOKEN: "h",
    AWS_PROFILE: "i",
    AWS_SECRET_ACCESS_KEY: "j",
    GOOGLE_APPLICATION_CREDENTIALS: "/k.json",
    STRIPE_SECRET: "l",
    DB_PASSWORD: "m",
    SIGNING_PRIVATE_KEY: "n",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    ACE_HOME: "/o",
  };
  const env = commandEnv(base, { CI: "1", DEPLOY_TOKEN: "smuggled" });
  const seen = Object.entries(env).filter(([, value]) => value !== undefined);
  expect(Object.fromEntries(seen)).toEqual({ CI: "1" });
  // Everything else the daemon has is left as it is, which the spawn inherits.
  const removed = Object.keys(env).filter((name) => env[name] === undefined);
  expect(removed.toSorted()).toEqual(
    Object.keys(base)
      .filter(
        (name) => !["PATH", "HOME", "GIT_AUTHOR_NAME", "TOKENIZERS_PARALLELISM"].includes(name),
      )
      .toSorted(),
  );
  // An agent asking for one by name is told it can't, rather than silently losing it.
  for (const name of ["GITHUB_TOKEN", "OPENAI_BASE_URL", "MY_API_KEY", "SSH_AUTH_SOCK", "ACE_X"])
    expect(CommandRunArgs.safeParse({ command: "make", env: { [name]: "x" } }).success, name).toBe(
      false,
    );
  expect(CommandRunArgs.safeParse({ command: "make", env: { NODE_ENV: "test" } }).success).toBe(
    true,
  );
});
