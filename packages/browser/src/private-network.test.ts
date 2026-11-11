import { expect, test } from "vitest";
import { reachesPrivateNetwork } from "./private-network.ts";

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
