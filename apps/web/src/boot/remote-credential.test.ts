import { expect, it } from "vitest";
import { browserCredential } from "./remote-credential.ts";

it("a saved remote host token without a paired identity cannot dial the daemon", async () => {
  await expect(
    browserCredential({ url: "wss://remote.example/", token: "a".repeat(64) })(),
  ).rejects.toThrow("Pair this device");
});
it("a local loopback connection can still authenticate with the host token", async () => {
  expect(await browserCredential({ url: "ws://127.0.0.1:4242/", token: "a".repeat(64) })()).toBe(
    "a".repeat(64),
  );
});
it("the desktop app's page presents its proof with the host token, so the daemon knows it's the app's", async () => {
  const appProof = "p".repeat(43);
  expect(
    await browserCredential({ url: "ws://127.0.0.1:4242/", token: "a".repeat(64), appProof })(),
  ).toEqual({ token: "a".repeat(64), appProof });
});
