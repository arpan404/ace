import { expect, it } from "vitest";
import { pairingLinkUrl, parsePairingLink } from "./pairing-link.ts";

const pin = "a".repeat(64);
const daemon = "https://studio.tail1234.ts.net:4243";

it("a link on the daemon's own web app pairs with that daemon", () => {
  const url = pairingLinkUrl({ daemon, fingerprint: pin, code: "c0de", scopes: ["read"] });
  expect(new URL(url).origin).toBe(daemon);
  expect(parsePairingLink(url)).toEqual({
    daemon: `${daemon}/`,
    code: "c0de",
    fingerprint: pin,
    scopes: ["read"],
  });
});

it("a link on the hosted web app opens there and still pairs with the daemon it names", () => {
  const url = pairingLinkUrl({
    daemon: `${daemon}/`,
    fingerprint: pin,
    code: "c0de",
    scopes: ["read", "operate"],
    app: "https://app.acehq.dev",
  });
  expect(new URL(url).origin).toBe("https://app.acehq.dev");
  expect(new URL(url).search).toBe("");
  expect(parsePairingLink(url)).toEqual({
    daemon: `${daemon}/`,
    code: "c0de",
    fingerprint: pin,
    scopes: ["read", "operate"],
  });
});

it("links that put credentials in the request or name a decorated computer are refused", () => {
  for (const link of [
    `${daemon}/pair?code=c0de`,
    `${daemon}/connect#code=c0de`,
    `https://user:secret@studio.tail1234.ts.net/pair#code=c0de`,
    `ace://pair#code=c0de`,
    `https://app.acehq.dev/pair#host=${encodeURIComponent(`${daemon}/v1`)}&code=c0de`,
    `https://app.acehq.dev/pair#host=${encodeURIComponent("https://u:p@studio.tail1234.ts.net")}&code=c0de`,
    `https://app.acehq.dev/pair#host=${encodeURIComponent("ftp://studio.tail1234.ts.net")}&code=c0de`,
  ])
    expect(() => parsePairingLink(link), link).toThrow();
});
