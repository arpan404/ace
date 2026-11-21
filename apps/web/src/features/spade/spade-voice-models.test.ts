import type { SpadeEndpoint, SpadeModelInfo } from "@ace/ui-core/spade-chat";
import { expect, test } from "vitest";
import { voiceModelChoices } from "./spade-voice-models.ts";

const model = (id: string, capabilities: string[] = []): SpadeModelInfo => ({
  id,
  name: id,
  context: undefined,
  capabilities,
  source: "listed",
});

const endpoint = (
  id: string,
  models: SpadeModelInfo[],
  more: Partial<SpadeEndpoint> = {},
): SpadeEndpoint => ({
  id,
  name: id.toUpperCase(),
  format: "openai-chat",
  baseUrl: `https://${id}.example/v1/`,
  sessionHeader: undefined,
  headerNames: [],
  needsKey: true,
  local: false,
  keySet: true,
  keySource: "keychain",
  models,
  raw: {},
  ...more,
});

test("an endpoint whose own list has a transcription model is offered with that model", () => {
  const openai = endpoint("openai", [model("gpt-5")]);
  const live = new Map([["openai", [model("gpt-5"), model("tts-1"), model("whisper-1")]]]);
  expect(voiceModelChoices("transcription", [openai], live)).toEqual([
    { model: "openai/whisper-1", endpointName: "OPENAI", modelName: "whisper-1" },
  ]);
  expect(voiceModelChoices("speech", [openai], live).map((each) => each.model)).toEqual([
    "openai/tts-1",
  ]);
});

test("a model whose saved facts say it transcribes wins over one that only sounds like it", () => {
  const local = endpoint("local", [model("whisper-tiny"), model("ears", ["transcription"])], {
    needsKey: false,
  });
  expect(voiceModelChoices("transcription", [local], new Map())[0]?.model).toBe("local/ears");
});

test.each([
  [
    "an Anthropic-format endpoint",
    endpoint("claude", [model("whisper-1")], { format: "anthropic" }),
  ],
  ["an endpoint without its key", endpoint("groq", [model("whisper-large-v3")], { keySet: false })],
  ["an endpoint with chat models only", endpoint("chat", [model("gpt-5"), model("kimi-k2")])],
])("%s offers nothing", (_, candidate) => {
  expect(voiceModelChoices("transcription", [candidate], new Map())).toEqual([]);
});

test("a transcription model is never offered to speak", () => {
  const groq = endpoint("groq", [model("distil-whisper-large-v3-en"), model("speech-to-text-1")]);
  expect(voiceModelChoices("speech", [groq], new Map())).toEqual([]);
});
