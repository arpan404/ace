import { expect, it } from "vitest";
import { OutputTail, commandEnv, timeoutFor } from "./command-rules.ts";

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
