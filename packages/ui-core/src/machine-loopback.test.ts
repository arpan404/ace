import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { isMachineLoopbackHost } from "./machine-loopback.ts";

const urlCases = JSON.parse(
  readFileSync(new URL("./machine-loopback-urls.json", import.meta.url), "utf8"),
) as { url: string; loopback: boolean }[];

test.each([
  ["localhost", true],
  ["LOCALHOST", true],
  ["localhost.", true],
  ["app.localhost", true],
  ["a.b.Localhost", true],
  ["api.localhost.", true],
  ["127.0.0.1", true],
  ["127.255.255.254", true],
  ["127.1.2.3.", true],
  ["::1", true],
  ["[::1]", true],
  ["[0:0:0:0:0:0:0:1]", true],
  ["::0:1", true],
  ["", false],
  [".", false],
  [".localhost", false],
  ["a..localhost", false],
  ["localhost.com", false],
  ["notlocalhost", false],
  ["mylocalhost", false],
  ["localhost.example.com", false],
  ["128.0.0.1", false],
  ["127.0.0.256", false],
  ["127.0.0", false],
  ["127.0.0.1.example.com", false],
  ["0.0.0.0", false],
  ["10.0.0.1", false],
  ["::", false],
  ["::2", false],
  ["[::ffff:127.0.0.1]", false],
  ["::1%lo0", false],
  ["1::1", false],
  ["[::1", false],
  ["example.com", false],
])("%j is the machine's loopback: %s", (hostname, expected) => {
  expect(isMachineLoopbackHost(hostname)).toBe(expected);
});

test("hostnames a URL parses from loopback addresses go to the machine", () => {
  for (const url of [
    "http://localhost:3000/",
    "http://127.0.0.1:5173/",
    "http://[::1]:8080/",
    "https://foo.localhost/",
    "http://LocalHost.:4000/",
  ])
    expect(isMachineLoopbackHost(new URL(url).hostname)).toBe(true);
  expect(isMachineLoopbackHost(new URL("https://example.com/").hostname)).toBe(false);
});

/*
 * URLs as a browser serializes a request's, shared with the phone's WebKit rule patterns
 * (`DevicePageEngine.loopbackPatterns`), which must name exactly these.
 */
test.each(urlCases)("$url goes to the machine: $loopback", ({ url, loopback }) => {
  expect(new URL(url).href).toBe(url);
  expect(isMachineLoopbackHost(new URL(url).hostname)).toBe(loopback);
});
