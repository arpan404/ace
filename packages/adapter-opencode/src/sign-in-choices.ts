import type { OpenCodeFormField, OpenCodeIntegration } from "./sign-in.ts";

/*
 * What ace offers when the person signs in to OpenCode, from the integrations OpenCode itself
 * lists. A browser (OAuth) method runs in ace's own dialog; an integration with only keys, or a
 * method whose form needs typing, runs in OpenCode's terminal, aimed at it.
 */

export type SignInRoute =
  | { kind: "browser"; integration: string; method: string; fields: OpenCodeFormField[] }
  | { kind: "terminal"; integration?: string; method?: string };
export interface SignInChoice {
  /** Model-source ids where one exists, so "Connect" on a source picks its choice. */
  id: string;
  label: string;
  route: SignInRoute;
}

/** Go and Zen are served through the OpenCode account; its browser sign-in connects both. */
const account = "opencode";
const accountSources = [
  { id: "opencode-go", label: "OpenCode Go" },
  { id: "opencode", label: "OpenCode Zen" },
];
/** The sources most people connect, in this order; the rest follow by name. */
const preferred = ["github-copilot", "openai", "anthropic", "openrouter", "xai"];
const choiceId = /^[a-z0-9_-]{1,64}$/;
/** The progress wire carries at most 32 choices; the last is always "other". */
const maxChoices = 31;

function rank(id: string): number {
  const index = preferred.indexOf(id);
  return index < 0 ? preferred.length : index;
}

function browserMethod(integration: OpenCodeIntegration) {
  const methods = integration.methods.filter((method) => method.type === "oauth" && method.id);
  return methods.find((method) => !/\(legacy\)/i.test(method.label ?? "")) ?? methods[0];
}

export function openCodeSignInChoices(
  integrations: readonly OpenCodeIntegration[],
): SignInChoice[] {
  const byId = new Map(integrations.map((integration) => [integration.id, integration]));
  const choices: SignInChoice[] = [];
  const opencode = byId.get(account);
  const accountMethod = opencode && browserMethod(opencode);
  for (const source of accountSources)
    if (accountMethod?.id)
      choices.push({
        id: source.id,
        label: `${source.label} (OpenCode account)`,
        route: {
          kind: "browser",
          integration: account,
          method: accountMethod.id,
          fields: accountMethod.form ?? [],
        },
      });
    else if (byId.has(source.id))
      choices.push({
        id: source.id,
        label: source.label,
        route: { kind: "terminal", integration: source.id },
      });
  const rest = integrations
    .filter(
      (integration) =>
        choiceId.test(integration.id) &&
        !integration.id.startsWith("mcp_") &&
        !accountSources.some((source) => source.id === integration.id),
    )
    .toSorted((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  for (const integration of rest) {
    const method = browserMethod(integration);
    if (method?.id)
      choices.push({
        id: integration.id,
        label: integration.name.slice(0, 128),
        route: {
          kind: "browser",
          integration: integration.id,
          method: method.id,
          fields: method.form ?? [],
        },
      });
    else if (preferred.includes(integration.id))
      choices.push({
        id: integration.id,
        label: integration.name.slice(0, 128),
        route: { kind: "terminal", integration: integration.id },
      });
  }
  return [
    ...choices.slice(0, maxChoices),
    { id: "other", label: "Another provider or an API key", route: { kind: "terminal" } },
  ];
}

export type FormStep =
  | { kind: "done"; answer: Record<string, string> }
  | { kind: "ask"; field: OpenCodeFormField & { options: { value: string; label: string }[] } }
  | { kind: "text" };

function applies(field: OpenCodeFormField, answer: Record<string, string>): boolean {
  return (field.when ?? []).every((rule) =>
    rule.op === "neq" ? answer[rule.key] !== rule.value : answer[rule.key] === rule.value,
  );
}

/**
 * The next step of a browser method's form: defaults fill themselves, a choice field is asked,
 * and a field that needs typing means OpenCode's terminal must take the sign-in.
 */
export function openCodeFormStep(
  fields: readonly OpenCodeFormField[],
  answered: Readonly<Record<string, string>>,
): FormStep {
  const answer = { ...answered };
  for (const field of fields) {
    if (field.key in answer || !applies(field, answer)) continue;
    if (typeof field.default === "string") {
      answer[field.key] = field.default;
      continue;
    }
    if (field.type === "string" && field.options?.length)
      return { kind: "ask", field: { ...field, options: field.options } };
    if (field.required) return { kind: "text" };
  }
  return { kind: "done", answer };
}
