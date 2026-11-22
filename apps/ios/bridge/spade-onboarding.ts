import {
  parseSpadeAgents,
  parseSpadeEndpoint,
  parseSpadeLiveModels,
  parseSpadeModels,
  spadeAboutYouNotes,
  spadeAboutYouQuestions,
  spadeModelState,
  spadeServerName,
  splitSpadeModel,
  voiceEndpoints,
  voiceModelChoices,
  type SpadeAboutYouField,
  type SpadeEndpoint,
  type SpadeModelInfo,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import {
  spadeAboutYouCard,
  spadeSetupCard,
  usable,
  type SpadeFootRow,
} from "./spade-onboarding-rows.ts";
import { keepKey, secretRefusal } from "./spade-secret-writes.ts";
import { addFromPreset } from "./spade-settings.ts";
import { segment } from "./spade-text.ts";

/*
 * First run from the phone (web's `spade-key-setup.tsx`, `spade-first-run.tsx` and
 * `spade-voice-setup.tsx`): what the foot of the main Spade's chat shows (the model and key it
 * answers with while it has none it can use, then the About-you interview), each step written to
 * Spade, and the transcription model voice messages need. A key travels once, to Spade, which
 * keeps it in the machine's keychain (ADR 0119); no answer carries it back, and a refused key is
 * said in fixed words.
 */

const conversationId = z.string().min(1).max(256);
const fields = spadeAboutYouQuestions.map((each) => each.field) as [
  SpadeAboutYouField,
  ...SpadeAboutYouField[],
];

export const spadeOnboardingRequests = [
  /** What the conversation's foot shows now; nothing unless it is the main Spade's. */
  z.object({ type: z.literal("spade.onboarding.read"), conversationId }),
  z.object({
    type: z.literal("spade.onboarding.model"),
    conversationId,
    /** `endpoint:<id>`, `preset:<id>` or `custom`. */
    choice: z.string().min(1).max(300),
    /** A key as pasted, sent once. */
    key: z.string().trim().min(1).max(8_192).optional(),
    /** A custom server's address. */
    address: z.string().trim().min(1).max(2_048).optional(),
    /** A model id on that endpoint; its first when none. */
    model: z.string().trim().min(1).max(512).optional(),
  }),
  z.object({
    type: z.literal("spade.onboarding.aboutYou"),
    conversationId,
    answers: z.partialRecord(z.enum(fields), z.string().max(2_000)).optional(),
    skip: z.literal(true).optional(),
  }),
  /** The transcription models the person's endpoints offer, for voice messages. */
  z.object({ type: z.literal("spade.onboarding.voice") }),
] as const;
export const NativeSpadeOnboardingRequest = z.discriminatedUnion("type", spadeOnboardingRequests);
export type NativeSpadeOnboardingRequest = z.infer<typeof NativeSpadeOnboardingRequest>;

export interface SpadeVoiceSetupRow {
  /** No transcription model is chosen yet. */
  needed: boolean;
  choices: { model: string; label: string }[];
  /** When none of the endpoints can, what to do instead; null while some can. */
  none: string | null;
}

type Refusal = { ok: false; title: string; message: string; picked?: string };
export type SpadeOnboardingAnswer =
  | Refusal
  | { ok: true; foot: SpadeFootRow }
  | { ok: true; voice: SpadeVoiceSetupRow };

type Ask = (
  method: "GET" | "POST" | "PUT" | "PATCH",
  route: string,
  body?: unknown,
) => Promise<string>;

const said = (error: unknown) => (error instanceof Error && error.message) || "Try again.";
const refused = (title: string, error: unknown): Refusal => ({
  ok: false,
  title,
  message: said(error),
});

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

const readModels = async (ask: Ask) =>
  sure(parseSpadeModels(await ask("GET", "/v1/models")), "models");

/** The main Spade, when `conversation` is its chat; undefined for any other bot's. */
async function mainOf(ask: Ask, conversation: string) {
  const agents = sure(parseSpadeAgents(await ask("GET", "/v1/agents")), "bots");
  return agents.find((agent) => agent.kind === "main" && agent.conversation === conversation);
}

/** What the foot shows: setup while Spade's model can't answer, then the interview, then none. */
async function readFoot(ask: Ask, conversation: string): Promise<SpadeFootRow> {
  const main = await mainOf(ask, conversation);
  if (!main) return null;
  const models = await readModels(ask);
  const state = spadeModelState(main.model, models.endpoints);
  if (state === "none") return { setup: spadeSetupCard(models) };
  if (state === "checking") return null;
  // A Spade before first run has no steps to keep: nothing to ask.
  const steps = await ask("GET", "/v1/onboarding").then(
    (body) => z.object({ about_you: z.unknown() }).safeParse(JSON.parse(body)),
    () => undefined,
  );
  if (!steps?.success) return null;
  const step = steps.data.about_you;
  return step === "done" || step === "skipped" ? null : { aboutYou: spadeAboutYouCard };
}

/** An address as Spade keeps it: ending in `/`, so model paths join onto it. */
const address = (typed: string) => (typed.endsWith("/") ? typed : `${typed}/`);

/** The model to answer with on `target`: the one picked, else Spade's own there, else its first. */
async function firstModel(
  ask: Ask,
  target: SpadeEndpoint,
  picked: string | undefined,
  now: string,
) {
  const current = splitSpadeModel(now);
  const known =
    picked || (current.endpoint === target.id ? current.model : "") || target.models[0]?.id;
  if (known) return known;
  let listed: SpadeModelInfo[] | undefined;
  try {
    listed = parseSpadeLiveModels(await ask("GET", `/v1/endpoints/${segment(target.id)}/models`));
  } catch (error) {
    throw new Error(
      `Couldn't list its models: ${said(error)}. Check the address, or type a model id.`,
      { cause: error },
    );
  }
  const first = listed?.[0]?.id;
  if (!first)
    throw new Error("It lists no models. Type the id of the model Spade should answer with.");
  return first;
}

type ModelRequest = Extract<NativeSpadeOnboardingRequest, { type: "spade.onboarding.model" }>;

/**
 * One step, as web's: the endpoint (one of the person's, a service added now, or their own
 * server), its key when it needs one, then Spade answering with that endpoint's model.
 */
async function setUpModel(ask: Ask, request: ModelRequest): Promise<SpadeOnboardingAnswer> {
  const title = "Couldn't set up the model";
  let main;
  let models;
  try {
    main = await mainOf(ask, request.conversationId);
    models = await readModels(ask);
  } catch (error) {
    return refused(title, error);
  }
  if (!main) return { ok: false, title, message: "Spade's model is set up from Spade's own chat." };
  const [kind, id = ""] = request.choice.split(/:(.*)/s);
  const custom = kind === "custom";
  let target =
    kind === "endpoint" ? models.endpoints.find((endpoint) => endpoint.id === id) : undefined;
  const preset = kind === "preset" ? models.presets.find((each) => each.id === id) : undefined;
  if (!target && !preset && !custom)
    return { ok: false, title, message: "That isn't on this machine's Spade any more." };
  const needsKey = preset !== undefined || (target !== undefined && !usable(target));
  const key = request.key;
  if (needsKey && !key) return { ok: false, title, message: "Paste its key first." };
  if (needsKey && !models.keychain)
    return { ok: false, title, message: "This machine has no keychain to keep keys in." };
  const typed = request.address;
  if (custom && !(typed && spadeServerName(typed)))
    return {
      ok: false,
      title,
      message: "Type the server's address, like http://localhost:11434/v1/.",
    };
  // Once an endpoint is made, a second try sets its key and model, never adds another.
  let made: string | undefined;
  const fail = (refusal: Refusal): Refusal => (made ? { ...refusal, picked: made } : refusal);
  try {
    if (custom && typed) {
      target = sure(
        parseSpadeEndpoint(
          await ask("POST", "/v1/endpoints", {
            name: spadeServerName(typed) ?? "My server",
            format: "openai-chat",
            base_url: address(typed),
            ...(key ? {} : { needs_key: false }),
          }),
        ),
        "new endpoint",
      );
    } else if (preset) {
      target = sure(await addFromPreset(ask, preset.id), "new endpoint");
    }
  } catch (error) {
    return refused(custom ? "Couldn't add the server" : "Couldn't add it", error);
  }
  if (!target) return { ok: false, title, message: "Try again." };
  if (custom || preset) made = `endpoint:${target.id}`;
  if (key && (needsKey || custom))
    try {
      await ask("PUT", `/v1/keys/${segment(target.id)}`, { key });
    } catch (error) {
      return fail(secretRefusal(keepKey, error));
    }
  try {
    const chosen = await firstModel(ask, target, request.model, main.model);
    const ref = `${target.id}/${chosen}`;
    if (ref !== main.model) await ask("PATCH", `/v1/agents/${segment(main.id)}`, { model: ref });
  } catch (error) {
    return fail(refused("Couldn't choose Spade's model", error));
  }
  try {
    return { ok: true, foot: await readFoot(ask, request.conversationId) };
  } catch {
    return { ok: true, foot: null };
  }
}

type AboutYouRequest = Extract<NativeSpadeOnboardingRequest, { type: "spade.onboarding.aboutYou" }>;

/** The interview's answers as shared notes every bot reads, then the step marked done. */
async function aboutYou(ask: Ask, request: AboutYouRequest): Promise<SpadeOnboardingAnswer> {
  try {
    if (request.skip) await ask("PUT", "/v1/onboarding", { about_you: "skipped" });
    else {
      for (const text of spadeAboutYouNotes(request.answers ?? {}))
        await ask("POST", "/v1/notes", { text });
      await ask("PUT", "/v1/onboarding", { about_you: "done" });
    }
  } catch (error) {
    return refused(request.skip ? "Couldn't skip it" : "Couldn't save your answers", error);
  }
  try {
    return { ok: true, foot: await readFoot(ask, request.conversationId) };
  } catch {
    return { ok: true, foot: null };
  }
}

/** The person's models that turn speech into words, one per endpoint, from each one's own list. */
async function voice(ask: Ask): Promise<SpadeOnboardingAnswer> {
  let models;
  try {
    models = await readModels(ask);
  } catch (error) {
    return refused("Couldn't read the models", error);
  }
  const lists = await Promise.all(
    voiceEndpoints(models.endpoints).map(async (endpoint) => {
      const listed = await ask("GET", `/v1/endpoints/${segment(endpoint.id)}/models`).then(
        (body) => parseSpadeLiveModels(body) ?? [],
        () => [],
      );
      return [endpoint.id, listed] as const;
    }),
  );
  const choices = voiceModelChoices("transcription", models.endpoints, new Map(lists)).map(
    (choice) => ({
      model: choice.model,
      label: `Use ${choice.endpointName} · ${choice.modelName}`,
    }),
  );
  return {
    ok: true,
    voice: {
      needed: !models.transcriptionModel,
      choices,
      none: choices.length
        ? null
        : "None of your endpoints turns speech into words. Add an OpenAI-format endpoint with a transcription model, such as OpenAI's whisper-1, in Settings › Spade › Models and keys.",
    },
  };
}

export async function answerSpadeOnboarding(
  request: NativeSpadeOnboardingRequest,
  ask: Ask,
): Promise<SpadeOnboardingAnswer> {
  switch (request.type) {
    case "spade.onboarding.read":
      try {
        return { ok: true, foot: await readFoot(ask, request.conversationId) };
      } catch (error) {
        return refused("Couldn't read Spade's setup", error);
      }
    case "spade.onboarding.model":
      return setUpModel(ask, request);
    case "spade.onboarding.aboutYou":
      return aboutYou(ask, request);
    case "spade.onboarding.voice":
      return voice(ask);
  }
}
