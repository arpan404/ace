/*
 * robots.txt as data. Every crawler may read the whole site, and the owner wants ace quoted by
 * AI assistants and answer engines, so each documented answer-engine and assistant agent is
 * named with an explicit Allow: some read only a group of their own. Names checked against each
 * vendor's own crawler page on 2026-11-18 (the `source` of each entry).
 */

export interface Crawler {
  agent: string;
  /** What the vendor says it is for. */
  purpose: string;
  /** The vendor's page documenting the name. */
  source: string;
}

const openai = "https://developers.openai.com/api/docs/bots";
const anthropic =
  "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler";
const perplexity = "https://docs.perplexity.ai/guides/bots";
const google = "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers";
const apple = "https://support.apple.com/en-us/119829";
const amazon = "https://developer.amazon.com/amazonbot";
const meta = "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/";
const mistral = "https://docs.mistral.ai/robots";

export const aiCrawlers: Crawler[] = [
  { agent: "OAI-SearchBot", purpose: "ChatGPT search results", source: openai },
  { agent: "ChatGPT-User", purpose: "Pages ChatGPT reads for a user", source: openai },
  { agent: "GPTBot", purpose: "OpenAI model training", source: openai },
  { agent: "Claude-SearchBot", purpose: "Claude's search results", source: anthropic },
  { agent: "Claude-User", purpose: "Pages Claude reads for a user", source: anthropic },
  { agent: "ClaudeBot", purpose: "Anthropic model training", source: anthropic },
  { agent: "PerplexityBot", purpose: "Perplexity search results", source: perplexity },
  { agent: "Perplexity-User", purpose: "Pages Perplexity reads for a user", source: perplexity },
  { agent: "Google-Extended", purpose: "Gemini training and grounding", source: google },
  { agent: "Applebot", purpose: "Siri, Spotlight and Safari search", source: apple },
  { agent: "Applebot-Extended", purpose: "Apple model training", source: apple },
  { agent: "Amazonbot", purpose: "Amazon products and AI", source: amazon },
  { agent: "Amzn-SearchBot", purpose: "Search in Amazon products such as Alexa", source: amazon },
  { agent: "Amzn-User", purpose: "Pages Alexa reads for a user", source: amazon },
  {
    agent: "DuckAssistBot",
    purpose: "DuckDuckGo's AI-assisted answers",
    source: "https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot",
  },
  {
    agent: "MistralAI-User",
    purpose: "Pages Mistral's assistant reads for a user",
    source: mistral,
  },
  { agent: "MistralAI-Index", purpose: "Mistral's search index", source: mistral },
  { agent: "meta-webindexer", purpose: "Meta AI search results", source: meta },
  { agent: "meta-externalagent", purpose: "Meta AI training and indexing", source: meta },
  { agent: "meta-externalfetcher", purpose: "Pages Meta AI reads for a user", source: meta },
  {
    agent: "CCBot",
    purpose: "Common Crawl's open web archive",
    source: "https://commoncrawl.org/ccbot",
  },
];

/** The robots.txt text: everyone allowed, each AI crawler named, and the sitemap when known. */
export function robotsTxt(sitemap: string | undefined): string {
  const lines = [
    "# Every crawler may read the whole site. AI assistants and answer engines are welcome to",
    "# read and quote it; the full text for them is at /llms.txt and /llms-full.txt.",
    "User-agent: *",
    "Allow: /",
    "",
    ...aiCrawlers.flatMap((crawler) => [
      `# ${crawler.purpose}`,
      `User-agent: ${crawler.agent}`,
      "Allow: /",
      "",
    ]),
    ...(sitemap ? [`Sitemap: ${sitemap}`] : []),
  ];
  return `${lines.join("\n").trim()}\n`;
}
