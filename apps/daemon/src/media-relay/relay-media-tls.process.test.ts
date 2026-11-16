import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { binary, firstChunk, setup, until, type RelayTls } from "./testing-relay.ts";

// ace-media's leg of a relay media stream over wss://, against the real self-hosted relay served
// over TLS. The certificates are fixtures (see __fixtures__/tls/README.md): ace-media trusts only
// the test CA, given as SSL_CERT_FILE to that child alone, so neither the keychain nor any
// system trust setting is read or changed. The daemon's and the client's own relay legs stay on
// the relay's plain listener; only the join ace-media dials goes over TLS.

const fixture = (name: string) =>
  fileURLToPath(new URL(`./__fixtures__/tls/${name}`, import.meta.url));
const pem = (name: string) => readFileSync(fixture(name), "utf8");
const leg = (cert: string, host = "localhost"): RelayTls => ({
  cert: pem(`${cert}.pem`),
  key: pem(`${cert}.key.pem`),
  trust: fixture("ca.pem"),
  host,
});

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe.skipIf(!binary)("relay media streams over wss://", { timeout: 30_000 }, () => {
  it("a stream is dialed over TLS, handed over and carries pictures from a keyframe", async () => {
    const t = await setup(cleanups, leg("localhost"));
    const tab = t.tab();
    const ticket = await t.mint(t.phone.deviceId);
    const { client, first } = await t.media(t.phone, ticket);
    expect(first).toMatchObject({ type: "welcome" });
    const dial = t.sent.find((s) => s.message.type === "relay.dial")?.message;
    expect(dial?.type === "relay.dial" && dial.url.startsWith("wss://localhost:")).toBe(true);
    // Frames sent before the welcome are ace-media's after the hand-over, over TLS too.
    for (let i = 0; i < 20; i++) await client.send({ type: "ping" });
    for (let i = 0; i < 20; i++) expect(await client.receive()).toEqual({ type: "pong" });
    await until(
      () => t.received.some((m) => m.type === "connection.open") && tab.source.streaming(),
    );
    const opened = t.received.findLast((m) => m.type === "connection.open");
    if (opened?.type !== "connection.open") throw new Error("no connection");
    expect(tab.bind(opened.connection)).toMatch(/^view-/);
    expect(await firstChunk(client)).toBe(true);
  });

  for (const [name, refused] of [
    ["a certificate for another host", leg("wrong-host")],
    ["an expired certificate", leg("expired")],
    ["a certificate from a CA ace-media doesn't trust", leg("untrusted")],
  ] as const)
    it(`${name} is refused, and the client is turned away at once to stay on legacy delivery`, async () => {
      const t = await setup(cleanups, refused);
      const ticket = await t.mint(t.phone.deviceId);
      const started = performance.now();
      // The relay turns the client away (the daemon rejects its ticket) long before the
      // ticket's own 10 s would have run out.
      await expect(t.media(t.phone, ticket)).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(t.received).toContainEqual(
        expect.objectContaining({ type: "relay.failed", reason: "tls" }),
      );
      expect(t.sent.some((s) => s.message.type === "relay.out")).toBe(false);
      expect(t.sent.some((s) => s.message.type === "relay.keys")).toBe(false);
      // ace-media stays up: a refused relay never costs the daemon its media process.
      expect(t.supervisor.health()).toBe("healthy");
    });
});
