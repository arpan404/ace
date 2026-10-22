import type { APIRoute } from "astro";

/*
 * Every crawler is welcome, AI assistants and answer engines included: being quoted accurately
 * by them is part of the point of the site. Named agents get explicit groups because some only
 * read their own.
 */
const aiCrawlers = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "meta-externalagent",
];

export const GET: APIRoute = ({ site }) => {
  const lines = [
    "User-agent: *",
    "Allow: /",
    "",
    ...aiCrawlers.flatMap((agent) => [`User-agent: ${agent}`, "Allow: /", ""]),
    ...(site ? [`Sitemap: ${new URL("/sitemap.xml", site).href}`] : []),
  ];
  return new Response(`${lines.join("\n").trim()}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
