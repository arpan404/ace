import { expect, test } from "vitest";
import { agentGuides } from "../content/agent-guides.ts";
import { downloadsFromRelease, releasePageDownloads } from "../content/release-download.ts";
import { routes } from "../content/routes.ts";
import { cardFor, cards } from "./cards.ts";
import { markdownPath, pageMarkdown } from "./markdown.ts";
import { knownMeta } from "./meta.ts";
import { aiCrawlers, robotsTxt } from "./robots.ts";
import { sitemapXml } from "./sitemap.ts";

const site = "https://acehq.dev";
const href = (path: string) => new URL(path, site).href;
const noRelease = releasePageDownloads(`${site}/releases`);
const release = downloadsFromRelease({
  tag_name: "v1.2.3",
  html_url: "https://github.com/arpan404/ace/releases/tag/v1.2.3",
  published_at: "2026-11-16T15:57:05Z",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "ace-1.2.3-arm64.dmg",
      size: 275_000_000,
      browser_download_url: "https://example.com/ace-1.2.3-arm64.dmg",
    },
    {
      name: "ace-1.2.3-x64-setup.exe",
      size: 238_000_000,
      browser_download_url: "https://example.com/ace-1.2.3-x64-setup.exe",
    },
  ],
});

test("every page has a Markdown twin that opens with its heading and a one-sentence definition", () => {
  for (const entry of routes) {
    const text = pageMarkdown(entry.path, href, noRelease);
    expect(text, entry.path).toBeDefined();
    const lines = text?.split("\n") ?? [];
    expect(lines[0], entry.path).toMatch(/^# \S/);
    if (!entry.path.endsWith("-policy/") && !entry.path.includes("terms")) {
      expect(lines[2], entry.path).toMatch(/^> \S.*\.$/);
    }
    expect(text, entry.path).toContain(`Web page: ${href(entry.path)}`);
  }
});

test("Markdown twins sit beside their pages and never collide", () => {
  const twins = routes.map((entry) => markdownPath(entry.path));
  expect(new Set(twins).size).toBe(twins.length);
  expect(markdownPath("/")).toBe("/index.md");
  expect(markdownPath("/features/fleet/")).toBe("/features/fleet.md");
});

test("a path with no page has no Markdown", () => {
  expect(pageMarkdown("/nowhere/", href, noRelease)).toBeUndefined();
});

test("the home and download Markdown state the version and only the builds the release has", () => {
  for (const path of ["/", "/download/"]) {
    const text = pageMarkdown(path, href, release) ?? "";
    expect(text).toContain("The current version of ace is 1.2.3, released on 2026-11-16.");
    expect(text).toContain("macOS on Apple silicon; Windows 10 and 11 on x64");
    expect(text).not.toContain("Intel");
  }
  expect(pageMarkdown("/", href, noRelease)).not.toContain("current version");
});

test("the home Markdown says what ace is and is not, without claiming a hosted mode", () => {
  const text = pageMarkdown("/", href, noRelease) ?? "";
  expect(text).toContain("## What ace is and is not");
  expect(text).toContain("Price: free");
  expect(text).toContain("License: Apache-2.0");
  expect(text).toMatch(/never asks for, stores or proxies provider credentials/);
});

test("the sitemap lists every page once, with its date", () => {
  const xml = sitemapXml(
    routes.map((entry) => href(entry.path)),
    "2026-11-18",
  );
  for (const entry of routes) {
    expect(xml.split(`<loc>${href(entry.path)}</loc>`).length - 1, entry.path).toBe(1);
  }
  expect(xml.match(/<lastmod>2026-11-18<\/lastmod>/g)?.length).toBe(routes.length);
  expect(xml).not.toContain("/og/");
});

test("the sitemap leaves lastmod out rather than guess one", () => {
  expect(sitemapXml([href("/")], undefined)).not.toContain("lastmod");
});

test("robots.txt allows everyone, names each AI crawler with Allow, and points at the sitemap", () => {
  const text = robotsTxt(`${site}/sitemap.xml`);
  expect(text).not.toMatch(/Disallow/);
  expect(text).toMatch(/User-agent: \*\nAllow: \//);
  for (const crawler of aiCrawlers) {
    expect(text, crawler.agent).toContain(`User-agent: ${crawler.agent}\nAllow: /`);
  }
  for (const agent of ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended"]) {
    expect(text).toContain(`User-agent: ${agent}\n`);
  }
  expect(text.trimEnd().endsWith(`Sitemap: ${site}/sitemap.xml`)).toBe(true);
});

const meta = knownMeta(agentGuides);

test("titles are at most 60 characters, name ace, and no two pages share one", () => {
  const titles = Object.values(meta).map((entry) => entry.title);
  expect(new Set(titles).size).toBe(titles.length);
  for (const title of titles) {
    expect(title.length, title).toBeLessThanOrEqual(60);
    expect(title, title).toMatch(/\bace\b/);
  }
});

test("descriptions are at most 155 characters and no two pages share one", () => {
  const descriptions = Object.values(meta).map((entry) => entry.description);
  expect(new Set(descriptions).size).toBe(descriptions.length);
  for (const description of descriptions) {
    expect(description.length, description).toBeLessThanOrEqual(155);
  }
});

test("every page in routes.ts except the three that write their own has its meta here", () => {
  const own = new Set(["/mcp/", "/security/", "/faq/"]);
  for (const entry of routes) {
    if (!own.has(entry.path)) expect(meta[entry.path], entry.path).toBeDefined();
  }
});

test("each social card belongs to a real page, and a page without one shares the home card", () => {
  const paths = new Set(routes.map((entry) => entry.path));
  for (const card of cards) expect(paths.has(card.path), card.name).toBe(true);
  expect(cardFor("/spade/").image).toBe("/og/spade.png");
  expect(cardFor("/").image).toBe("/og.png");
  expect(cardFor("/features/fleet/").image).toBe("/og.png");
});
