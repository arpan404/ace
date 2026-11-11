import "./test-host.ts";
import { expect, test } from "vitest";
import { providerPage } from "./provider-page-view.ts";

test("default model choices include models beyond the first 200", () => {
  const page = providerPage({
    provider: "codex",
    status: undefined,
    configuration: undefined,
    configurations: [],
    nativeMode: "",
    modes: [],
    machine: "studio",
    admin: true,
    catalog: {
      models: Array.from({ length: 240 }, (_, index) => ({
        provider: "codex",
        id: `model-${index}`,
        displayName: `Model ${index}`,
        instance: "default",
        nativeModelId: `model-${index}`,
        efforts: [],
        serviceTiers: [],
        hidden: false,
        deprecated: false,
        raw: { json: "{}", truncated: false },
      })),
      instances: [],
    },
  });
  expect(page.models?.defaultModel?.choices).toHaveLength(240);
  expect(page.models?.defaultModel?.choices.some((choice) => choice.id === "model-239")).toBe(true);
});
