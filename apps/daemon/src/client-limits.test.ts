import { once } from "node:events";
import { createServer } from "node:http";
import { X509Certificate } from "node:crypto";
import { expect, it } from "vitest";
import { accessRequest } from "./client-access.ts";
import { cleanups, identity, setup } from "./remote-test-support.ts";

it("rejects oversized successful HTTP responses before decoding their JSON", async () => {
  const server = createServer((_request, response) =>
    response.end(JSON.stringify({ data: "x".repeat(2 * 1024 * 1024) })),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Listener missing");
  await expect(accessRequest(`http://127.0.0.1:${address.port}`, "/")).rejects.toThrow(
    "Response too large",
  );
});

it.each(["expired", "not yet valid"])(
  "rejects a correctly pinned certificate that is %s",
  async (state) => {
    const f = await setup();
    const certificate = new X509Certificate(identity.cert);
    const at =
      state === "expired" ? Date.parse(certificate.validTo) : Date.parse(certificate.validFrom) - 1;
    await expect(
      accessRequest(f.server.remoteUrl.replace("wss:", "https:"), "/v1/pair", {
        method: "POST",
        fingerprint: identity.fingerprint,
        now: () => at,
        body: { code: "wrong", name: "Phone" },
      }),
    ).rejects.toThrow("TLS certificate expired or not yet valid");
  },
);

it("evaluates certificate time once even when the clock changes during validation", async () => {
  const f = await setup();
  const certificate = new X509Certificate(identity.cert);
  const readings = [
    Date.parse(certificate.validFrom) + 1000,
    Date.parse(certificate.validTo) + 1000,
  ];
  const paired = await f.pair(["admin"]);
  await expect(
    accessRequest(f.server.remoteUrl.replace("wss:", "https:"), "/v1/devices", {
      token: paired.token,
      fingerprint: identity.fingerprint,
      now: () => readings.shift() ?? Date.parse(certificate.validTo) + 1000,
    }),
  ).resolves.toMatchObject([{ id: paired.device.id }]);
});
