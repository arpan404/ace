import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readAppKey } from "./app-key-input.ts";

const hex = "cd".repeat(32);
/** Started by the signed app, which stays its parent. */
const app = { parent: () => 4242, isApp: async (pid: number) => pid === 4242 };

/** Timers the test fires by hand. */
function timers() {
  const pending: (() => void)[] = [];
  return {
    delay: (run: () => void) => {
      pending.push(run);
      return () => {
        const at = pending.indexOf(run);
        if (at >= 0) pending.splice(at, 1);
      };
    },
    fire: () => {
      for (const run of pending.splice(0)) run();
    },
  };
}

describe("ace start reads the desktop app's key", () => {
  it("from stdin when the app says one is there, and drops the flag from its environment", async () => {
    const env: NodeJS.ProcessEnv = { ACE_APP_KEY: "stdin" };
    const stdin = new PassThrough();
    const read = readAppKey(env, () => stdin, timers().delay, app);
    stdin.end(`${hex}\n`);
    expect(await read).toEqual(new Uint8Array(32).fill(0xcd));
    expect(env.ACE_APP_KEY).toBeUndefined();
  });

  it("never opens stdin without the flag, which a login service or a terminal never sets", async () => {
    let opened = false;
    const key = await readAppKey(
      {},
      () => {
        opened = true;
        return new PassThrough();
      },
      timers().delay,
      app,
    );
    expect(key).toBeUndefined();
    expect(opened).toBe(false);
  });

  it("starts without a key when stdin stays open past the wait", async () => {
    const clock = timers();
    const stdin = new PassThrough();
    const read = readAppKey({ ACE_APP_KEY: "stdin" }, () => stdin, clock.delay, app);
    stdin.write(hex);
    clock.fire();
    expect(await read).toBeUndefined();
  });

  it("starts without a key for more than one key line", async () => {
    const stdin = new PassThrough();
    const read = readAppKey({ ACE_APP_KEY: "stdin" }, () => stdin, timers().delay, app);
    stdin.end(`${hex}\n`.repeat(4));
    expect(await read).toBeUndefined();
  });
});

describe("ace start counts the key only from the signed app", () => {
  it("ignores a key another launcher wrote, as a process holding the token would", async () => {
    const stdin = new PassThrough();
    const other = { parent: () => 777, isApp: async (pid: number) => pid === 4242 };
    const read = readAppKey({ ACE_APP_KEY: "stdin" }, () => stdin, timers().delay, other);
    stdin.end(`${hex}\n`);
    expect(await read).toBeUndefined();
  });

  it("ignores the key when its launcher was the app but is no longer this daemon's parent", async () => {
    const stdin = new PassThrough();
    let parent = 4242;
    const leaving = {
      parent: () => parent,
      isApp: async (pid: number) => {
        // The app exits while it is checked; the daemon is someone else's child now.
        parent = 1;
        return pid === 4242;
      },
    };
    const read = readAppKey({ ACE_APP_KEY: "stdin" }, () => stdin, timers().delay, leaving);
    stdin.end(`${hex}\n`);
    expect(await read).toBeUndefined();
  });
});
