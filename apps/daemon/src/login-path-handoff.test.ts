import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { firstLine, receiveLoginPath } from "./login-path-handoff.ts";

const never = new Promise<void>(() => {});

test("a daemon started on a saved PATH runs providers on the login shell's newer one", async () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", ACE_LOGIN_PATH_PENDING: "1" };
  const input = new PassThrough();
  const changed = receiveLoginPath({ env, read: () => firstLine(input), timeout: never });
  input.write("/opt/homebrew/bin:/usr/");
  input.write("bin:/bin\n");
  expect(await changed).toBe(true);
  expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  expect(env.ACE_LOGIN_PATH_PENDING).toBeUndefined();
});

test("an unchanged login PATH reports no change", async () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", ACE_LOGIN_PATH_PENDING: "1" };
  expect(await receiveLoginPath({ env, read: async () => "/usr/bin:/bin", timeout: never })).toBe(
    false,
  );
  expect(env.PATH).toBe("/usr/bin:/bin");
});

test("a daemon nobody promised a PATH to does not wait for one", async () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  expect(await receiveLoginPath({ env, read: () => never.then(() => "x"), timeout: never })).toBe(
    false,
  );
});

test("an app that quits before its shell answers leaves the starting PATH", async () => {
  const env: NodeJS.ProcessEnv = { PATH: "/saved/bin", ACE_LOGIN_PATH_PENDING: "1" };
  const input = new PassThrough();
  const changed = receiveLoginPath({ env, read: () => firstLine(input), timeout: never });
  input.end("/partial");
  expect(await changed).toBe(false);
  expect(env.PATH).toBe("/saved/bin");
});

test("a shell that never answers stops holding providers back at the timeout", async () => {
  const env: NodeJS.ProcessEnv = { PATH: "/saved/bin", ACE_LOGIN_PATH_PENDING: "1" };
  const timeout = Promise.withResolvers<void>();
  const changed = receiveLoginPath({
    env,
    read: () => new Promise(() => {}),
    timeout: timeout.promise,
  });
  timeout.resolve();
  expect(await changed).toBe(false);
  expect(env.PATH).toBe("/saved/bin");
});
