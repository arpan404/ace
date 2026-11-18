import { PassThrough } from "node:stream";
import { encodeLoginPathLine, type PendingLoginPath } from "@ace/service/login-path";
import { expect, test } from "vitest";
import { firstLine, followLoginPath, onFinalPath, receiveLoginPath } from "./login-path-handoff.ts";

const never = () => new Promise<never>(() => {});
const pending = JSON.stringify({ prefix: "/bundled", inherited: "/usr/bin:/bin" });

function started(path = "/bundled:/saved/bin"): NodeJS.ProcessEnv {
  return { PATH: path, ACE_LOGIN_PATH_PENDING: pending };
}

test("the app's login PATH becomes final, and environments copied before it take it first", async () => {
  const env = started();
  const input = new PassThrough();
  const loginPath = receiveLoginPath({
    env,
    read: () => firstLine(input),
    timeout: never,
    lookup: never,
  });
  const copy = followLoginPath(loginPath, { ...env });
  const order: string[] = [];
  loginPath?.onChange(() => order.push("copies"));
  const final = loginPath?.final.then((changed) => order.push(`final ${changed}`));
  input.write(encodeLoginPathLine("/bundled:/opt/homebrew/bin:/usr/bin"));
  await final;
  expect(env.PATH).toBe("/bundled:/opt/homebrew/bin:/usr/bin");
  expect(copy.PATH).toBe("/bundled:/opt/homebrew/bin:/usr/bin");
  expect(order).toEqual(["copies", "final true"]);
  expect(env.ACE_LOGIN_PATH_PENDING).toBeUndefined();
});

test("an unchanged login PATH changes nothing", async () => {
  const env = started();
  const loginPath = receiveLoginPath({
    env,
    read: async () => encodeLoginPathLine("/bundled:/saved/bin"),
    timeout: never,
    lookup: never,
  });
  const changes: string[] = [];
  loginPath?.onChange((path) => changes.push(path));
  expect(await loginPath?.final).toBe(false);
  expect(changes).toEqual([]);
});

test("a daemon nobody promised a PATH to never waits for one", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  expect(receiveLoginPath({ env, read: never, timeout: never, lookup: never })).toBeUndefined();
});

test("an app that quits before its shell answers leaves the daemon to ask the shell itself", async () => {
  const env = started();
  const input = new PassThrough();
  const asked: PendingLoginPath[] = [];
  const loginPath = receiveLoginPath({
    env,
    read: () => firstLine(input),
    timeout: never,
    lookup: async (request) => {
      asked.push(request);
      return "/bundled:/login/bin:/usr/bin:/bin";
    },
  });
  input.end('"/partial');
  expect(await loginPath?.final).toBe(true);
  // Asked as the app would have asked it; the saved PATH is never the final one.
  expect(asked).toEqual([{ prefix: "/bundled", inherited: "/usr/bin:/bin" }]);
  expect(env.PATH).toBe("/bundled:/login/bin:/usr/bin:/bin");
});

test("past the timeout the daemon's own lookup is final, and a late line from the app is ignored", async () => {
  const env = started();
  const input = new PassThrough();
  const timeout = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<string>();
  const loginPath = receiveLoginPath({
    env,
    read: () => firstLine(input),
    timeout: () => timeout.promise,
    lookup: () => lookup.promise,
  });
  const changes: string[] = [];
  loginPath?.onChange((path) => changes.push(path));
  let final: boolean | undefined;
  void loginPath?.final.then((changed) => (final = changed));
  timeout.resolve();
  await new Promise((settle) => setImmediate(settle));
  // Still waiting: providers are not read on the saved PATH meanwhile.
  expect(final).toBeUndefined();
  lookup.resolve("/bundled:/own/bin");
  await loginPath?.final;
  input.write(encodeLoginPathLine("/bundled:/late/bin"));
  await new Promise((settle) => setImmediate(settle));
  expect(env.PATH).toBe("/bundled:/own/bin");
  expect(changes).toEqual(["/bundled:/own/bin"]);
});

test("a PATH with spaces, quotes and a newline in a folder name arrives exactly", async () => {
  const env = started();
  const input = new PassThrough();
  const path = '/bundled:/Users/me/My Tools/bin:/odd "quoted"\nfolder: /trailing ';
  const loginPath = receiveLoginPath({
    env,
    read: () => firstLine(input),
    timeout: never,
    lookup: never,
  });
  input.write(encodeLoginPathLine(path));
  expect(await loginPath?.final).toBe(true);
  expect(env.PATH).toBe(path);
});

test("an environment that fails to take the PATH is reported, and the rest and providers still get it", async () => {
  const env = started();
  const reports: string[] = [];
  const loginPath = receiveLoginPath({
    env,
    read: async () => encodeLoginPathLine("/bundled:/login/bin"),
    timeout: never,
    lookup: never,
    log: (message) => reports.push(message),
  });
  loginPath?.onChange(() => {
    throw new Error("frozen copy");
  });
  const healthy = followLoginPath(loginPath, { PATH: "/bundled:/saved/bin" });
  expect(await loginPath?.final).toBe(true);
  expect(healthy.PATH).toBe("/bundled:/login/bin");
  expect(reports).toEqual([expect.stringContaining("frozen copy")]);
});

test("a daemon that stops while waiting settles its PATH unchanged and starts no lookup", async () => {
  const env = started();
  const stop = new AbortController();
  let lookups = 0;
  const loginPath = receiveLoginPath({
    env,
    read: never,
    timeout: never,
    lookup: async () => {
      lookups++;
      return "/bundled:/login/bin";
    },
    signal: stop.signal,
  });
  stop.abort();
  expect(await loginPath?.final).toBe(false);
  expect(env.PATH).toBe("/bundled:/saved/bin");
  expect(lookups).toBe(0);
});

test("a doctor request waiting on the PATH when the daemon stops is refused and runs no discovery", async () => {
  const final = Promise.withResolvers<boolean>();
  const stopped = new AbortController();
  let discoveries = 0;
  const request = onFinalPath(final.promise, stopped.signal, async () => {
    discoveries++;
    return "report";
  });
  // Shutdown aborts first, then settles the PATH unchanged.
  stopped.abort();
  final.resolve(false);
  await expect(request).rejects.toThrow("ace is stopping");
  expect(discoveries).toBe(0);
});

test("a doctor request runs once the PATH is final", async () => {
  expect(
    await onFinalPath(Promise.resolve(true), new AbortController().signal, async () => "report"),
  ).toBe("report");
});

test("a stopping daemon lets go of a stdin the app keeps open without a line", async () => {
  const input = new PassThrough();
  const stop = new AbortController();
  const line = firstLine(input, { signal: stop.signal });
  input.write("/partial");
  stop.abort();
  expect(await line).toBeUndefined();
  expect(input.destroyed).toBe(true);
  expect(input.listenerCount("data")).toBe(0);
});
