import { expect, test } from "vitest";
import { privateAddress, reachesPrivateNetwork } from "./private-network.ts";

const names: Record<string, string[]> = {
  "example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
  "printer.lan": ["192.168.1.20"],
  "rebind.example": ["93.184.215.14", "127.0.0.1"],
};
const resolve = async (host: string) => {
  const found = names[host];
  if (!found) throw new Error("ENOTFOUND");
  return found;
};

test.each([
  ["http://localhost:3000/", true],
  ["http://app.localhost/", true],
  ["http://127.0.0.1/", true],
  ["http://[::1]:8080/", true],
  ["http://[::ffff:10.0.0.1]/", true],
  ["http://10.1.2.3/", true],
  ["http://172.20.0.1/", true],
  ["http://192.168.0.1/admin", true],
  ["http://169.254.169.254/latest/meta-data", true],
  ["http://100.100.1.1/", true],
  ["http://[fe80::1]/", true],
  ["http://[fd12::1]/", true],
  ["http://0.0.0.0/", true],
  ["https://printer.lan/", true],
  // One local address among a name's addresses is enough to refuse it.
  ["https://rebind.example/", true],
  // A name that can't be checked is refused.
  ["https://unknown.invalid/", true],
  ["https://example.com/", false],
  ["https://93.184.215.14/", false],
  ["https://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/", false],
  // Not a network URL: the origin policy decides.
  ["about:blank", false],
])("%s reaches this machine or its network: %s", async (url, expected) => {
  expect(await reachesPrivateNetwork(url, resolve)).toBe(expected);
});

test.each([
  ["127.0.0.1", true],
  ["93.184.215.14", false],
  ["::", true],
  ["::1", true],
  ["0:0:0:0:0:0:0:1", true],
  ["2606:2800:21f:cb07:6820:80da:af6b:8b2c", false],
  // IPv4-mapped, as typed and as URLs write it.
  ["::ffff:127.0.0.1", true],
  ["::ffff:7f00:1", true],
  ["::ffff:93.184.215.14", false],
  // IPv4-translated (::ffff:0:a.b.c.d).
  ["::ffff:0:127.0.0.1", true],
  ["::ffff:0:7f00:1", true],
  ["::ffff:0:a00:1", true],
  ["::ffff:0:5db8:d70e", false],
  // IPv4-compatible (::a.b.c.d).
  ["::127.0.0.1", true],
  ["::7f00:1", true],
  ["::a9fe:a9fe", true],
  ["::5db8:d70e", false],
  // NAT64: the well-known prefix reaches the address it carries; the local-use prefix is local.
  ["64:ff9b::127.0.0.1", true],
  ["64:ff9b::a9fe:a9fe", true],
  ["64:ff9b::c0a8:101", true],
  ["64:ff9b::5db8:d70e", false],
  ["64:ff9b:1::5db8:d70e", true],
  // 6to4 carries its IPv4 address after the prefix.
  ["2002:7f00:1::1", true],
  ["2002:5db8:d70e::1", false],
  ["fd00::1", true],
  ["fe80::1%en0", true],
  ["ff02::1", true],
  ["not an address", true],
])("%s is private: %s", (address, expected) => {
  expect(privateAddress(address)).toBe(expected);
});
