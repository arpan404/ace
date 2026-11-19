import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SHIPPED_APPS, configureApps } from "./apps.ts";

const trim = (url: string) => url.replace(/\/$/, "");

it("every connector Spade signs in to through the cloud has an app here, for the same server", async () => {
  const catalogue = JSON.parse(
    await readFile(join(import.meta.dirname, "../../../../spade/config/connectors.json"), "utf8"),
  ) as { connectors: { id: string; url: string; via?: string }[] };
  const viaCloud = catalogue.connectors.filter((entry) => entry.via === "cloud");
  expect(viaCloud.map((entry) => entry.id).toSorted()).toEqual(
    SHIPPED_APPS.map((app) => app.id).toSorted(),
  );
  for (const entry of viaCloud)
    expect(trim(SHIPPED_APPS.find((app) => app.id === entry.id)?.resource ?? "")).toBe(
      trim(entry.url),
    );
});

it("an app signs people in only when both of its secrets are set", () => {
  const apps = configureApps({
    SPADE_CLOUD_ASANA_CLIENT_ID: "asana-id",
    SPADE_CLOUD_ASANA_CLIENT_SECRET: " asana-secret\n",
    SPADE_CLOUD_BOX_CLIENT_ID: "box-id",
  });
  expect(apps?.filter((each) => each.client).map((each) => each.app.id)).toEqual(["asana"]);
  expect(apps?.[0]?.client).toEqual({ id: "asana-id", secret: "asana-secret" });
});

const app = (token: string) =>
  JSON.stringify([
    {
      id: "a",
      name: "A",
      issuer: "https://a.example",
      authorization_endpoint: "https://a.example/auth",
      token_endpoint: token,
      client_auth: "client_secret_post",
      resource: "https://a.example/mcp",
      client_id_env: "A_ID",
      client_secret_env: "A_SECRET",
    },
  ]);

it("a replacement list with plain http off this machine, or that doesn't read, gives no apps", () => {
  expect(configureApps({ SPADE_CLOUD_APPS: app("http://127.0.0.1:9/token") })).toHaveLength(1);
  expect(configureApps({ SPADE_CLOUD_APPS: app("http://a.example/token") })).toBeUndefined();
  expect(configureApps({ SPADE_CLOUD_APPS: "{" })).toBeUndefined();
});
