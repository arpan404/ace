import { expect, it } from "vitest";
import {
  exchangeTicket,
  reconnectCredential,
  socketUrlFor,
  pairedSocketCredential,
} from "./tickets.ts";

const TOKEN = "e0".repeat(32);
const TICKET = "f1".repeat(32);

function jsonResponse(value: unknown): Response {
  const text = JSON.stringify(value);
  return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
}

it("derives the socket URL from the daemon origin without credentials", () => {
  expect(socketUrlFor("https://192.168.1.20:4243/")).toBe("wss://192.168.1.20:4243/");
  for (const bad of [
    "https://user@host:1/",
    "https://host:1/path",
    "https://host:1/?x=1",
    "http://192.168.1.20:4243/",
    "http://127.0.0.1:4345/",
    "not a url",
  ]) {
    expect(() => socketUrlFor(bad), bad).toThrow();
  }
});

it("never upgrades cleartext loopback, matching iOS pinned HTTPS", () => {
  expect(() => socketUrlFor("http://127.0.0.1:4345/")).toThrow("HTTPS");
  expect(() => socketUrlFor("http://localhost:4345/")).toThrow("HTTPS");
});

it("exchanges a fresh ticket on every connection attempt", async () => {
  let calls = 0;
  const seen: string[] = [];
  const fetch = async (input: string, init: RequestInit) => {
    calls++;
    const url = new URL(input);
    expect(url.hash).toBe("");
    expect(url.search).toBe("");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    seen.push((init.headers as Record<string, string>).authorization ?? "");
    return jsonResponse({ ticket: TICKET, expiresAt: 1_800_000_000_000 });
  };
  const first = await exchangeTicket({
    daemonOrigin: "https://192.168.1.20:4243/",
    token: async () => TOKEN,
    fetch,
  });
  const second = await exchangeTicket({
    daemonOrigin: "https://192.168.1.20:4243/",
    token: async () => TOKEN,
    fetch,
  });
  expect(calls).toBe(2);
  expect(first.ticket).toBe(TICKET);
  expect(second.ticket).toBe(TICKET);
  expect(new Set(seen)).toEqual(new Set([`Bearer ${TOKEN}`]));
});

it("re-reads the stored token on every attempt so re-pairing takes effect", async () => {
  let current = TOKEN;
  const seen: string[] = [];
  const credential = reconnectCredential({
    loadToken: async () => current,
    exchange: async (token: string) => {
      seen.push(token);
      return { ticket: TICKET, expiresAt: 1_800_000_000_000 };
    },
  });
  await expect(credential()).resolves.toEqual({ ticket: TICKET });
  current = "d2".repeat(32);
  await expect(credential()).resolves.toEqual({ ticket: TICKET });
  expect(seen).toEqual([TOKEN, "d2".repeat(32)]);
});

it("surfaces an auth failure when the token loader cannot read", async () => {
  const credential = pairedSocketCredential({
    socketUrl: "wss://192.168.1.20:4243/",
    token: async () => {
      throw new Error("locked");
    },
    fetch: async () => jsonResponse({ ticket: TICKET, expiresAt: 1 }),
  });
  await expect(credential()).rejects.toMatchObject({ code: "auth" });
});
