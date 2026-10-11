import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { AccessClient } from "./index.ts";
import { accessTicket, type AccessOptions } from "./access.ts";
import { setup } from "./test-support.ts";

const ticketClients = [
  { name: "access client", create: (options: AccessOptions) => new AccessClient(options) },
  {
    name: "ticket exchange",
    create: (options: AccessOptions) => ({ ticket: () => accessTicket(options) }),
  },
];

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
    expect(await access.devices()).toContainEqual(paired.device);
    expect(await phone.ticket()).toMatchObject({ ticket: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await accessTicket({ origin, token: async () => paired.token, fetch })).toMatchObject({
      ticket: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await access.revoke(paired.device.id)).toEqual({ revoked: true });
    await expect(phone.ticket()).rejects.toMatchObject({ code: "auth", message: "HTTP 401" });
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

test.each(
  ticketClients.flatMap(({ name, create }) =>
    [401, 403, 429, 500, 503].map((status) => ({ name, create, status })),
  ),
)(
  "$name HTTP $status chooses re-pairing only for denied credentials",
  async ({ status, create }) => {
    const access = create({
      origin: "https://computer.test/",
      token: async () => "a".repeat(64),
      fetch: async () => new Response("{}", { status }),
    });
    await expect(access.ticket()).rejects.toMatchObject({
      code: status === 401 || status === 403 ? "auth" : "offline",
    });
  },
);
test.each(ticketClients)("a network failure during $name remains retryable", async ({ create }) => {
  const access = create({
    origin: "https://computer.test/",
    token: async () => "a".repeat(64),
    fetch: async () => {
      throw new TypeError("network down");
    },
  });
  await expect(access.ticket()).rejects.toMatchObject({ code: "offline" });
});
test("a pairing request that never responds expires and can be retried", async () => {
  let expire: (() => void) | undefined;
  let pending = true;
  const access = new AccessClient({
    origin: "https://computer.test/",
    token: async () => "",
    schedule: (run) => {
      expire = run;
      return () => {};
    },
    fetch: async () => {
      if (pending) return new Promise<Response>(() => {});
      return new Response("{}", { status: 401 });
    },
  });
  const request = access.redeem("a".repeat(32), "Laptop");
  expire?.();
  await expect(request).rejects.toMatchObject({ code: "offline" });
  pending = false;
  await expect(access.redeem("a".repeat(32), "Laptop")).rejects.toMatchObject({ code: "auth" });
});

test.each(ticketClients)(
  "$name validates the ticket response and bounds HTTP body reads",
  async ({ create }) => {
    for (const body of ['{"ticket":"not-a-ticket"}', " ".repeat(1_048_577)]) {
      const access = create({
        origin: "https://computer.test/",
        token: async () => "a".repeat(64),
        fetch: async () => new Response(body),
      });
      await expect(access.ticket()).rejects.toMatchObject(
        body.length > 1_048_576 ? { code: "limit" } : { name: "ZodError" },
      );
    }
  },
);
