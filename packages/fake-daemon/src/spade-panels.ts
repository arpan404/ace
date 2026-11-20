import type { FakeSpadeAgent } from "./spade-agent.ts";
import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * A packaged bot's panels (ADR 0200 §5.2) as Spade serves them: `GET /v1/conversations/{id}/panels`
 * lists each with its page's hash and its latest state, `GET /v1/panels/pages/{hash}` answers the
 * page as text, and `POST …/panels/{id}/actions {key, action, value?}` stores a declared action
 * once by key, as the person's press. The value's schema check is Spade's; here an action is
 * refused only when its panel doesn't declare it.
 */

type Json = Record<string, unknown>;

export interface FakePanel {
  id: string;
  title: string;
  html: string;
  actions: readonly { name: string; label?: string }[];
}

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string): FakeSpadeAnswer => reply({ error }, status);

/** A stable stand-in for a page's sha256: 64 hex digits from its text. */
function pageHash(text: string): string {
  let out = "";
  for (let round = 0; round < 8; round++) {
    let hash = 0x811c9dc5 ^ round;
    for (let at = 0; at < text.length; at++) {
      hash ^= text.charCodeAt(at);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out;
}

export class FakeSpadePanels {
  readonly #byAgent = new Map<string, FakePanel[]>();
  readonly #reactions = new Map<string, (action: { name: string; value: unknown }) => void>();
  readonly #pages = new Map<string, string>();
  readonly #events: (conversation: string) => Json[];
  readonly #store: (conversation: string, event: Json) => void;

  constructor(deps: {
    events: (conversation: string) => Json[];
    store: (conversation: string, event: Json) => void;
  }) {
    this.#events = deps.events;
    this.#store = deps.store;
  }

  /** Gives `agent` its package's panels; `react` plays the bot's answer to each action. */
  set(
    agent: FakeSpadeAgent,
    panels: readonly FakePanel[],
    react?: (action: { name: string; value: unknown }) => void,
  ): void {
    this.#byAgent.set(agent.id, [...panels]);
    if (react) this.#reactions.set(agent.id, react);
    for (const panel of panels) this.#pages.set(pageHash(panel.html), panel.html);
  }

  /** The bot set a panel's state with `panel_update`. */
  update(agent: FakeSpadeAgent, surface: string, data: unknown): void {
    this.#store(agent.conversation, {
      type: "panel_updated",
      surface,
      call_id: `panel-${surface}-${this.#events(agent.conversation).length}`,
      data,
    });
  }

  /** `GET /v1/panels/pages/{hash}`. */
  page(hash: string): FakeSpadeAnswer {
    const text = this.#pages.get(hash);
    return text === undefined ? problem(404, "no such page") : { status: 200, body: text };
  }

  /** `…/conversations/{id}/panels[/{panel}/actions]` for the bot whose conversation it is. */
  conversationRoute(
    method: string,
    agent: FakeSpadeAgent | undefined,
    panel: string | undefined,
    tail: string | undefined,
    body: unknown,
  ): FakeSpadeAnswer {
    const panels = agent ? (this.#byAgent.get(agent.id) ?? []) : [];
    if (!agent) return problem(404, "no such conversation");
    const events = this.#events(agent.conversation);
    if (method === "GET" && panel === undefined)
      return reply({
        panels: panels.map((each) => ({
          id: each.id,
          title: each.title,
          page: pageHash(each.html),
          actions: each.actions.map((action) => action.name),
          state:
            events.findLast((event) => event.type === "panel_updated" && event.surface === each.id)
              ?.data ?? null,
        })),
      });
    if (method !== "POST" || tail !== "actions") return problem(404, "not found");
    const declared = panels.find((each) => each.id === panel);
    if (!declared) return problem(404, "no such panel");
    const fields = typeof body === "object" && body !== null ? (body as Json) : {};
    const action = declared.actions.find((each) => each.name === fields["action"]);
    if (!action) return problem(400, "The panel declares no such action.");
    const key = String(fields["key"] ?? "");
    if (!events.some((event) => event.type === "panel_action" && event.key === key)) {
      this.#store(agent.conversation, {
        type: "panel_action",
        surface: declared.id,
        key,
        action: action.name,
        label: action.label ?? action.name,
        ...(fields["value"] === undefined ? {} : { value: fields["value"] }),
      });
      this.#reactions.get(agent.id)?.({ name: action.name, value: fields["value"] });
    }
    return reply({}, 202);
  }
}
