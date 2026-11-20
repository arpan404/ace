import { describe, expect, it } from "vitest";
import { createSlackApp, type Fetch, runSlack, SLACK_CREATE_URL, type SlackRun } from "./slack.ts";
import type { BrokerEntry, Registry } from "./types.ts";

const slack: BrokerEntry = {
  id: "slack",
  name: "Slack",
  kind: "broker",
  status: "not-started",
  started: null,
  order: 31,
  minutes: 10,
  blocked_on: null,
  notes: [],
  apps: ["slack"],
  redirects: ["https://cloud.acehq.dev/v1/oauth/callback/slack"],
  scopes: ["search:read.public", "chat:write"],
  secrets: ["SPADE_CLOUD_SLACK_CLIENT_ID", "SPADE_CLOUD_SLACK_CLIENT_SECRET"],
  console: "https://api.slack.com/apps",
  where: "Your Apps.",
};

const registry: Registry = {
  about: "test",
  app: {
    name: "Spade",
    homepage: "https://acehq.dev",
    privacy: "https://acehq.dev/privacy",
    terms: "https://acehq.dev/terms",
    description: "Spade, the assistant.",
    logo: "icon.png",
    contact: "team@example.com",
  },
  registrations: [slack],
};

type Call = { url: string; init: RequestInit };

function fakeSlack(answer: unknown): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer), {
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, calls };
}

const created = {
  ok: true,
  app_id: "A0SPADE",
  credentials: { client_id: "123.456", client_secret: "s3cr3t-value" },
};

function run(overrides: Partial<SlackRun> & Pick<SlackRun, "fetch">) {
  const out: string[] = [];
  const err: string[] = [];
  const options: SlackRun = {
    registry,
    args: ["--yes"],
    token: "xoxe.xoxp-config",
    isTTY: true,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...overrides,
  };
  return { done: runSlack(options), out, err };
}

describe("creating Spade's Slack app", () => {
  it("posts the manifest to apps.manifest.create with the configuration token", async () => {
    const { fetch, calls } = fakeSlack(created);
    await createSlackApp({ display_information: { name: "Spade" } }, "xoxe-token", fetch);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(SLACK_CREATE_URL);
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("Authorization")).toBe("Bearer xoxe-token");
    const form = new URLSearchParams(String(call?.init.body));
    expect(JSON.parse(form.get("manifest") ?? "null")).toEqual({
      display_information: { name: "Spade" },
    });
  });

  it("sends the registry's redirect and user scopes, and no bot scopes", async () => {
    const { fetch, calls } = fakeSlack(created);
    const { done } = run({ fetch });
    expect(await done).toBe(0);
    const form = new URLSearchParams(String(calls[0]?.init.body));
    expect(JSON.parse(form.get("manifest") ?? "null")).toEqual({
      display_information: { name: "Spade", description: "Spade, the assistant." },
      oauth_config: {
        redirect_urls: ["https://cloud.acehq.dev/v1/oauth/callback/slack"],
        scopes: { user: ["search:read.public", "chat:write"] },
      },
      settings: {
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
  });

  it("prints the client ID, both wrangler commands, and the secret exactly once", async () => {
    const { fetch } = fakeSlack(created);
    const { done, out } = run({ fetch });
    expect(await done).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Client ID: 123.456");
    expect(text).toContain("wrangler secret put SPADE_CLOUD_SLACK_CLIENT_ID --env production");
    expect(text).toContain("wrangler secret put SPADE_CLOUD_SLACK_CLIENT_SECRET --env production");
    expect(text.split("s3cr3t-value")).toHaveLength(2);
    expect(text).not.toContain("xoxe.xoxp-config");
  });

  it("refuses without --yes, and asks Slack nothing", async () => {
    const { fetch, calls } = fakeSlack(created);
    const { done, err } = run({ fetch, args: [] });
    expect(await done).toBe(1);
    expect(calls).toEqual([]);
    expect(err.join("\n")).toContain("--yes");
  });

  it("refuses when output isn't a terminal, before creating anything", async () => {
    const { fetch, calls } = fakeSlack(created);
    const { done, out } = run({ fetch, isTTY: false });
    expect(await done).toBe(1);
    expect(calls).toEqual([]);
    expect(out).toEqual([]);
  });

  it("refuses without a configuration token", async () => {
    const { fetch, calls } = fakeSlack(created);
    const { done } = run({ fetch, token: " " });
    expect(await done).toBe(1);
    expect(calls).toEqual([]);
  });

  it("reports Slack's refusal with its details", async () => {
    const { fetch } = fakeSlack({
      ok: false,
      error: "invalid_manifest",
      errors: [{ message: "must be a valid URL", pointer: "/oauth_config/redirect_urls/0" }],
    });
    await expect(createSlackApp({}, "token", fetch)).rejects.toThrow(
      "Slack refused: invalid_manifest\n/oauth_config/redirect_urls/0: must be a valid URL",
    );
  });
});
