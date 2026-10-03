import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { AccessClient } from "./index.ts";
import { setup } from "./test-support.ts";

test("HTTP access reads devices, issues a ticket and revokes it without durable commands or URL credentials", async () => {
  const f = await setup();
  const token = (await readFile(f.daemon.tokenPath, "utf8")).trim();
  const origin = new URL(f.daemon.url.replace(/^ws:/, "http:")).origin;
  const paired = f.daemon.store.devices.create("Phone", ["read", "operate"], 1);
  const urls: string[] = [];
  const access = new AccessClient({
    origin,
    token: async () => token,
    fetch(input, init) {
      urls.push(input);
      return fetch(input, init);
    },
  });
  const phone = new AccessClient({ origin, token: async () => paired.token, fetch });
  try {
    expect(await access.devices()).toEqual([paired.device]);
    expect(await phone.ticket()).toMatchObject({ ticket: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await access.revoke(paired.device.id)).toEqual({ revoked: true });
    await expect(phone.ticket()).rejects.toMatchObject({ code: "daemon", message: "HTTP 401" });
    expect(urls.every((url) => !url.includes(token) && !url.includes(paired.token))).toBe(true);
    expect(
      f.daemon.store.atomic(
        (db) => db.prepare("SELECT count(*) AS n FROM command_receipts").get()?.n,
      ),
    ).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("access rejects remote cleartext and embedded URL credentials before any network work", () => {
  const options = { token: async () => "a".repeat(64), fetch };
  expect(() => new AccessClient({ ...options, origin: "http://remote.example" })).toThrow(
    "Trusted HTTPS",
  );
  expect(
    () => new AccessClient({ ...options, origin: "https://owner:secret@remote.example" }),
  ).toThrow("Trusted HTTPS");
  expect(
    () => new AccessClient({ ...options, origin: "https://remote.example/?token=secret" }),
  ).toThrow("Trusted HTTPS");
});
