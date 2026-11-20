import { describe, expect, it } from "vitest";
import { artefacts } from "./artefacts.ts";
import { checkGenerated } from "./check.ts";
import { renderRunbook } from "./html.ts";
import { loadRegistry, paths, readDoc, repoRoot } from "./registry.ts";
import { renderMarkdown, renderOutreach, slackManifest } from "./render.ts";
import { type ApprovalEntry, type BrokerEntry, Registry } from "./types.ts";

const app = {
  name: "Spade",
  homepage: "https://acehq.dev",
  privacy: "https://acehq.dev/privacy",
  terms: "https://acehq.dev/terms",
  description: "Spade, the assistant.",
  logo: "icon.png",
  contact: "team@example.com",
};

const slack: BrokerEntry = {
  id: "slack",
  name: "Slack <beta>",
  kind: "broker",
  status: "blocked",
  started: "2026-11-19",
  order: 31,
  minutes: 10,
  blocked_on: "the marketplace listing",
  notes: ["Listed apps only."],
  apps: ["slack"],
  redirects: ["https://cloud.acehq.dev/v1/oauth/callback/slack"],
  scopes: ["search:read.public", "chat:write"],
  secrets: ["SLACK_ID", "SLACK_SECRET"],
  console: "https://api.slack.com/apps",
  where: "Your Apps.",
};

const ramp: ApprovalEntry = {
  id: "ramp",
  name: "Ramp",
  kind: "approval",
  status: "not-started",
  started: null,
  order: 23,
  minutes: 10,
  blocked_on: null,
  notes: [],
  ask: "We'd like Ramp to allowlist Spade's redirect.",
  channel: "Ramp's allowlist form",
  console: "https://docs.ramp.com/form",
  client_document: "https://acehq.dev/oauth/spade.json",
  redirects: ["http://127.0.0.1/v1/connectors/callback"],
};

const registry: Registry = { about: "test", app, registrations: [slack, ramp] };

describe("the checklist", () => {
  const markdown = renderMarkdown(registry);

  it("lists registrations in order, the shortest order first", () => {
    expect(markdown.indexOf("## 1. Ramp")).toBeGreaterThan(-1);
    expect(markdown.indexOf("## 2. Slack")).toBeGreaterThan(markdown.indexOf("## 1. Ramp"));
  });

  it("gives a status row with minutes and what it is blocked on", () => {
    expect(markdown).toContain(
      "| Slack <beta> | ace cloud app | Blocked | 10 | the marketplace listing |",
    );
  });

  it("puts each redirect and scope on its own line, then the secret commands", () => {
    const body = markdown.slice(markdown.indexOf("## 2. Slack"));
    expect(body).toContain("```\nhttps://cloud.acehq.dev/v1/oauth/callback/slack\n```");
    expect(body).toContain("```\nsearch:read.public\nchat:write\n```");
    expect(body).toContain(
      "XDG_CONFIG_HOME=~/.ace-cloudflare bunx wrangler secret put SLACK_ID --env production\n" +
        "XDG_CONFIG_HOME=~/.ace-cloudflare bunx wrangler secret put SLACK_SECRET --env production",
    );
    expect(body).toContain("Console: <https://api.slack.com/apps>");
    expect(body).toContain("- Listed apps only.");
  });

  it("is reported stale when the committed file differs", () => {
    expect(checkGenerated(paths.doc, markdown, markdown)).toEqual([]);
    expect(checkGenerated(paths.doc, markdown, `${markdown}edited\n`)).toEqual([
      `${paths.doc} is stale: run bun run docs:connectors`,
    ]);
    expect(checkGenerated(paths.doc, markdown, undefined)).toHaveLength(1);
  });

  it("is current in the repository", async () => {
    const committed = await readDoc(repoRoot);
    expect(committed).toBe(renderMarkdown(await loadRegistry(repoRoot)));
  });
});

describe("the runbook page", () => {
  const html = renderRunbook(registry);

  it("has a checkbox for every field, carrying the value to copy", () => {
    const boxes = html.match(/type="checkbox" data-key="spade-runbook:slack:\d+"/g) ?? [];
    // Five identity fields, one redirect, two scopes, two secret commands.
    expect(boxes).toHaveLength(10);
    expect(html).toContain("<code>chat:write</code>");
    expect(html).toContain(
      "<code>XDG_CONFIG_HOME=~/.ace-cloudflare bunx wrangler secret put SLACK_SECRET --env production</code>",
    );
  });

  it("escapes values rather than rendering them as markup", () => {
    expect(html).toContain("Slack &lt;beta&gt;");
    expect(html).not.toContain("Slack <beta>");
  });

  it("loads nothing from the network and follows the system's colour scheme", () => {
    expect(html).not.toMatch(/<link|\ssrc=|@import|url\(/);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('name="viewport"');
  });
});

describe("outreach", () => {
  it("carries the ask and every value the maker needs", () => {
    const message = renderOutreach(ramp, app);
    for (const value of [
      ramp.ask,
      "https://acehq.dev/oauth/spade.json",
      "http://127.0.0.1/v1/connectors/callback",
      "https://acehq.dev/privacy",
      "https://acehq.dev/terms",
      "team@example.com",
      "https://docs.ramp.com/form",
    ])
      expect(message).toContain(value);
  });

  it("answers a maker's form field by field, in its order, with registry values filled in", () => {
    const vercel: ApprovalEntry = {
      ...ramp,
      id: "vercel",
      name: "Vercel",
      form: [
        { field: "Primary Contact Name", answer: "<your name>" },
        { field: "Primary Contact Email", answer: "{contact}" },
        { field: "MCP Client OAuth Redirect URI(s)", answer: "{redirect} (loopback)" },
      ],
    };
    const lines = renderOutreach(vercel, app)
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(lines).toEqual([
      "- Primary Contact Name: <your name>",
      "- Primary Contact Email: team@example.com",
      "- MCP Client OAuth Redirect URI(s): http://127.0.0.1/v1/connectors/callback (loopback)",
    ]);
  });

  it("refuses a form answer naming a value the registry doesn't have", () => {
    const entry = { ...ramp, form: [{ field: "Logo", answer: "{logo_url}" }] };
    const parsed = Registry.safeParse({ about: "test", app, registrations: [entry] });
    expect(parsed.success).toBe(false);
    expect(Registry.safeParse({ about: "test", app, registrations: [ramp] }).success).toBe(true);
  });

  it("is written once per approval entry", () => {
    const files = [...artefacts(registry).keys()].filter((path) => path.includes("/outreach/"));
    expect(files).toEqual([`${paths.out}/outreach/ramp.md`]);
  });
});

describe("the Slack manifest", () => {
  it("asks for the registry's user scopes and nothing else", () => {
    expect(slackManifest(registry)).toEqual({
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
});
