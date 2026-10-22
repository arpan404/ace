import { acpAgents, builtInAgents } from "../content/agents.ts";
import { capabilities, faq, features, fleetPoints, product } from "../content/product.ts";
import { download } from "../content/release.ts";
import { links } from "../site.ts";

/*
 * schema.org data for the home page: the app, its source code and the FAQ. Search engines use it
 * for rich results, and AI assistants read it as the page's facts. URLs that need the site's
 * address are only added once it is known, since a relative @id is worse than none.
 */
export function structuredData(site: URL | undefined) {
  const at = (path: string) => (site ? new URL(path, site).href : undefined);
  const app = at("/#app");

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        ...(app ? { "@id": app } : {}),
        name: product.name,
        headline: product.headline,
        description: product.about,
        applicationCategory: product.category,
        applicationSubCategory: "AI coding agent manager",
        operatingSystem: "macOS",
        processorRequirements: "Apple silicon (arm64)",
        ...(site ? { url: site.href, image: at("/og.png"), screenshot: at("/og.png") } : {}),
        downloadUrl: download.url,
        installUrl: download.url,
        ...(download.version ? { softwareVersion: download.version } : {}),
        ...(download.bytes ? { fileSize: `${Math.round(download.bytes / 1_000_000)}MB` } : {}),
        ...(download.publishedAt ? { datePublished: download.publishedAt } : {}),
        releaseNotes: download.notesUrl,
        license: links.license,
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        featureList: [
          ...capabilities.map((capability) => `${capability.title}: ${capability.body}`),
          ...fleetPoints.map((point) => `Fleet, ${point.title.toLowerCase()}: ${point.body}`),
          "One MCP toolset for every agent: delegate, browser, computer use, devices, threads, visualizations and automations.",
          ...features.map((feature) => `${feature.title}: ${feature.body}`),
        ],
        softwareRequirements: `One or more coding-agent CLIs, such as ${builtInAgents
          .map((agent) => agent.label)
          .join(", ")}`,
        keywords: [
          "coding agents",
          "AI coding agent manager",
          "multi-agent",
          "agent orchestration",
          "computer use",
          "browser use",
          "iOS Simulator",
          "Android emulator",
          "MCP server",
          "git worktrees",
          ...builtInAgents.map((agent) => agent.label),
          ...acpAgents.map((agent) => agent.label),
        ].join(", "),
        sameAs: [links.source],
      },
      {
        "@type": "SoftwareSourceCode",
        name: `${product.name} source code`,
        codeRepository: links.source,
        programmingLanguage: ["TypeScript", "Swift"],
        license: links.license,
        ...(app ? { targetProduct: { "@id": app } } : {}),
      },
      {
        "@type": "FAQPage",
        ...(site ? { "@id": at("/#faq") } : {}),
        mainEntity: faq.map((entry) => ({
          "@type": "Question",
          name: entry.question,
          acceptedAnswer: { "@type": "Answer", text: entry.answer },
        })),
      },
    ],
  };
}
