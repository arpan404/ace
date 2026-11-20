import { describe, expect, test } from "vitest";
import { parseSpadeLocalServers, spadeLocalChoices, spadeLocalServerWords } from "./index.ts";

const body = JSON.stringify({
  servers: [
    {
      id: "ollama",
      name: "Ollama",
      base_url: "http://127.0.0.1:11434/v1/",
      running: true,
      models: ["gemma3:4b", "qwen3:8b"],
      endpoint: null,
    },
    {
      id: "lmstudio",
      name: "LM Studio",
      base_url: "http://127.0.0.1:1234/v1/",
      running: false,
      models: [],
      endpoint: null,
    },
    { name: "no id" },
  ],
});

describe("models on this computer", () => {
  test("a running Ollama is found with its models, in plain words", () => {
    const [ollama, lmstudio] = parseSpadeLocalServers(body);
    expect(ollama && spadeLocalServerWords(ollama)).toBe("Runs on this computer · 2 models");
    expect(lmstudio && spadeLocalServerWords(lmstudio)).toBe("Not running on this computer");
    expect(parseSpadeLocalServers(body)).toHaveLength(2);
  });

  test("the picker offers the models of running servers not added yet", () => {
    const servers = parseSpadeLocalServers(body);
    expect(spadeLocalChoices(servers).map((choice) => choice.model)).toEqual([
      "gemma3:4b",
      "qwen3:8b",
    ]);
    const added = servers.map((s) => Object.assign({}, s, { endpoint: "e_1" }));
    expect(spadeLocalChoices(added)).toEqual([]);
  });

  test("an answer that isn't a list reads as no servers", () => {
    expect(parseSpadeLocalServers("not json")).toEqual([]);
    expect(parseSpadeLocalServers("{}")).toEqual([]);
  });
});
