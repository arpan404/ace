import { expect, test } from "vitest";
import { matchingServices } from "./service-search.ts";

const services = [
  { id: "github-copilot", label: "GitHub Copilot" },
  { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway" },
  { id: "vercel", label: "Vercel AI Gateway" },
  { id: "wafer.ai", label: "Wafer" },
  { id: "other", label: "Other provider" },
];
const ids = (query: string) => matchingServices(services, query).map((service) => service.id);

test("typing narrows the services to those whose name holds every word, in their order", () => {
  expect(ids("gateway")).toEqual(["cloudflare-ai-gateway", "vercel", "other"]);
  expect(ids("AI  gate cloud")).toEqual(["cloudflare-ai-gateway", "other"]);
});

test("a service is found by its id as well as its name", () => {
  expect(ids("wafer.ai")).toEqual(["wafer.ai", "other"]);
  expect(ids("copilot")).toEqual(["github-copilot", "other"]);
});

test("an empty search keeps every service, and any search keeps the way to another provider", () => {
  expect(ids("  ")).toEqual(services.map((service) => service.id));
  expect(ids("nothing matches this")).toEqual(["other"]);
});
