import {
  parseSpadeAgent,
  parseSpadeTemplates,
  spadeAgentTaskMax,
  spadeFreeName,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { initialOf, type SpadeFaceRow } from "./spade-group-rows.ts";
import { readModelSources } from "./spade-settings.ts";
import {
  spadeModelChoices,
  spadeModelSetting,
  type SpadeModelGroupRow,
  type SpadeModelSettingRow,
} from "./spade-settings-rows.ts";
import { segment, type NativeSpade } from "./spade.ts";

/*
 * A new bot from the phone (ADR 0197, docs/design/spade.md §5): the person says what it should
 * do, and that message is its task and its first message, in one call; it names itself as it
 * starts. A template the machine ships (ADR 0132) brings its own name, face and task instead,
 * and the message is its first job. The model is optional: left alone, new bots start on
 * Settings' model for them.
 */

export const spadeNewBotRequests = [
  /** What New bot offers: the templates, and the models a bot may start on. */
  z.object({ type: z.literal("spade.newbot.read") }),
  z.object({
    type: z.literal("spade.newbot.create"),
    text: z.string().trim().max(200_000),
    template: z.string().min(1).max(256).optional(),
    model: z.string().min(1).max(512).optional(),
    /** The phone's IANA zone, for a template's routines. */
    timeZone: z.string().min(1).max(64).optional(),
  }),
] as const;
export const NativeSpadeNewBotRequest = z.discriminatedUnion("type", spadeNewBotRequests);
export type NativeSpadeNewBotRequest = z.infer<typeof NativeSpadeNewBotRequest>;

export interface SpadeTemplateRow {
  id: string;
  name: string;
  /** One line on what it does. */
  blurb: string;
  face: SpadeFaceRow;
}

type Refusal = { ok: false; title: string; message: string };
export type SpadeNewBotAnswer =
  | Refusal
  | {
      ok: true;
      templates: SpadeTemplateRow[];
      model: SpadeModelSettingRow;
      groups: SpadeModelGroupRow[];
      more: number;
    }
  | { ok: true; agentId: string; conversation: string };

type Ask = (method: "GET" | "POST", route: string, body?: unknown) => Promise<string>;

const refused = (title: string, error: unknown): Refusal => ({
  ok: false,
  title,
  message: (error instanceof Error && error.message) || "Try again.",
});

export async function answerSpadeNewBot(
  spade: NativeSpade,
  request: NativeSpadeNewBotRequest,
  ask: Ask,
): Promise<SpadeNewBotAnswer> {
  if (!spade.ready) return { ok: false, title: "", message: spade.placeSentence };
  if (request.type === "spade.newbot.read") {
    try {
      const [templates, { models, sources }] = await Promise.all([
        // A machine whose templates can't be read still makes a bot from a message.
        ask("GET", "/v1/templates").then(
          (body) => parseSpadeTemplates(body) ?? [],
          () => [],
        ),
        readModelSources(ask),
      ]);
      return {
        ok: true,
        templates: templates.map((template) => ({
          id: template.id,
          name: template.name,
          blurb: template.blurb,
          face: { main: false, initial: initialOf(template.name), away: false },
        })),
        model: { ...spadeModelSetting("new_bot", models, sources), title: "Model" },
        ...spadeModelChoices(sources),
      };
    } catch (error) {
      return refused("Couldn't read New bot", error);
    }
  }
  return create(spade, request, ask);
}

async function create(
  spade: NativeSpade,
  request: Extract<NativeSpadeNewBotRequest, { type: "spade.newbot.create" }>,
  ask: Ask,
): Promise<SpadeNewBotAnswer> {
  const text = request.text;
  if (!text && !request.template)
    return { ok: false, title: "", message: "Say what the bot should do." };
  const chosen = request.model ? { model: request.model } : {};
  const draft = request.template
    ? {
        // A template brings its own name, face and task; the message is its first job.
        name: spadeFreeName((await templateName(ask, request.template)) ?? "New bot", [
          ...spade.names.values(),
        ]),
        task: "",
        template: request.template,
        ...(request.timeZone ? { time_zone: request.timeZone } : {}),
        ...chosen,
      }
    : // The message is its task; it names itself as it starts.
      { task: Array.from(text).slice(0, spadeAgentTaskMax).join(""), naming: true, ...chosen };
  try {
    const body = await ask("POST", "/v1/agents", {
      ...draft,
      ...(text ? { first_message: { text } } : {}),
    });
    const agent = parseSpadeAgent(body);
    if (!agent) throw new Error("Spade's new bot didn't make sense.");
    // A Spade from before first messages makes the bot and drops the message: send it now.
    if (text && !agent.lastMessage)
      await ask("POST", `/v1/conversations/${segment(agent.conversation)}/messages`, { text });
    spade.refresh();
    return { ok: true, agentId: agent.id, conversation: agent.conversation };
  } catch (error) {
    return refused("Couldn't make the bot", error);
  }
}

async function templateName(ask: Ask, id: string): Promise<string | undefined> {
  const templates = await ask("GET", "/v1/templates").then(parseSpadeTemplates, () => undefined);
  return templates?.find((template) => template.id === id)?.name || undefined;
}
