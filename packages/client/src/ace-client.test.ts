import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aceClientName, namedFetch } from "./ace-client.ts";
import type { PortableSocket } from "./portable-relay.ts";
import { relayRoute } from "./relay-route.ts";

// How an app names itself to ace cloud and the market (ADR 0189).

describe("an app's ace-client name", () => {
  it.each([
    ["0.0.24-beta.1", "desktop/0.0.24-beta.1"],
    ["0.0.23", "desktop/0.0.23"],
    ["development", "desktop/development"],
    [undefined, undefined],
    ["", undefined],
    ["0.0.24+build.5", undefined],
    ["latest", undefined],
  ])("from version %j is %j", (version, name) => {
    expect(aceClientName("desktop", version)).toBe(name);
  });
});

describe("a named fetch", () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.headers));
  });
  let origin = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const sent = async (fetch: typeof globalThis.fetch | ReturnType<typeof namedFetch>) =>
    (await (
      await fetch(`${origin}/v1/account/session`, { headers: { authorization: "Bearer t" } })
    ).json()) as Record<string, string>;

  it("names the app on the request and keeps the caller's own headers", async () => {
    const headers = await sent(namedFetch(fetch, aceClientName("daemon", "0.0.24-beta.2")));
    expect(headers["ace-client"]).toBe("daemon/0.0.24-beta.2");
    expect(headers.authorization).toBe("Bearer t");
  });

  it("sends no name for an app that has none", async () => {
    const headers = await sent(namedFetch(fetch, aceClientName("web", undefined)));
    expect(headers["ace-client"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer t");
  });
});

describe("a browser relay upgrade", () => {
  /** The URL each dial opens; every socket closes at once without opening. */
  function dialled(aceClient: ReturnType<typeof aceClientName>) {
    const urls: string[] = [];
    const socket = (url: string): PortableSocket => {
      urls.push(url);
      const closers: ((event: { code: number; reason: string }) => void)[] = [];
      queueMicrotask(() => {
        for (const close of closers) close({ code: 1006, reason: "" });
      });
      return {
        binaryType: "arraybuffer",
        bufferedAmount: 0,
        protocol: "",
        addEventListener(type: string, listener: (event: never) => void) {
          if (type === "close") closers.push(listener);
        },
        send() {},
        close() {},
      };
    };
    const route = relayRoute({
      relayUrl: "wss://relay.invalid",
      hostId: "A".repeat(52),
      aceClient,
      credential: async () => ({ token: "device token" }),
      socket,
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    });
    return new Promise<URL>((resolve) =>
      route.transport().open({
        open: () => {},
        message: () => {},
        close: () => resolve(new URL(urls[0] ?? "wss://none.invalid")),
      }),
    );
  }

  it("carries the app's name on the URL, beside the relay's own parameters", async () => {
    const url = await dialled(aceClientName("web", "0.0.24-beta.1"));
    expect(url.searchParams.get("ace-client")).toBe("web/0.0.24-beta.1");
    expect(url.searchParams.get("hostId")).toBe("A".repeat(52));
  });

  it("carries nothing for an app without a name", async () => {
    const url = await dialled(undefined);
    expect(url.searchParams.has("ace-client")).toBe(false);
    expect(url.searchParams.get("hostId")).toBe("A".repeat(52));
  });
});
