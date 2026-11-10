import type { OpenCodeFormField, OpenCodeIntegration } from "./sign-in.ts";

/*
 * What ace offers when the person signs in to OpenCode: every integration OpenCode itself lists
 * that can be signed in to. A browser (OAuth) method runs in ace's own dialog; an integration with
 * only keys, or a method whose form needs typing, runs in OpenCode's terminal, aimed at it, so ace
 * never sees a key.
 */

export type SignInRoute =
  | { kind: "browser"; integration: string; method: string; fields: OpenCodeFormField[] }
  | { kind: "terminal"; integration?: string; method?: string };
export interface SignInChoice {
  /** Model-source ids where one exists, so "Connect" on a source picks its choice. */
  id: string;
  label: string;
  /** Its earlier login didn't carry over to OpenCode's current store: sign in again. */
  note?: "sign_in_again";
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
/** Never `-` or `.` first, so an id can't read as a flag or a path on OpenCode's command line. */
const choiceId = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The progress wire carries at most 512 choices; the last is always "other". */
const maxChoices = 511;

function browserMethod(integration: OpenCodeIntegration) {
  const methods = integration.methods.filter((method) => method.type === "oauth" && method.id);
  return methods.find((method) => !/\(legacy\)/i.test(method.label ?? "")) ?? methods[0];
}

/** Something OpenCode's sign-in can take: a key, a browser or an external login, not only env. */
const canSignIn = (integration: OpenCodeIntegration) =>
  integration.methods.some((method) => method.type !== "env");

/**
 * Every integration OpenCode can sign in to, as choices. `earlier` names the integrations whose
 * login OpenCode kept before its current store (auth.json): one not connected now is marked.
 */
export function openCodeSignInChoices(
  integrations: readonly OpenCodeIntegration[],
  earlier: ReadonlySet<string> = new Set(),
): SignInChoice[] {
  const byId = new Map(integrations.map((integration) => [integration.id, integration]));
  const connected = (id: string) => (byId.get(id)?.connections.length ?? 0) > 0;
  // Go is served through a connected OpenCode account even without its own login.
  const lapsed = (id: string) =>
    earlier.has(id) && !connected(id) && !(id === "opencode-go" && connected(account));
  const note = (id: string) => (lapsed(id) ? { note: "sign_in_again" as const } : {});
  const choices: SignInChoice[] = [];
  const opencode = byId.get(account);
  const accountMethod = opencode && browserMethod(opencode);
  for (const source of accountSources)
    if (accountMethod?.id)
      choices.push({
        id: source.id,
        label: `${source.label} (OpenCode account)`,
        ...note(source.id),
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
        ...note(source.id),
        route: { kind: "terminal", integration: source.id },
      });
  // Logins to renew first, then the usual ones, then everything else by name.
  const rank = (id: string) => {
    if (lapsed(id)) return -1;
    const index = preferred.indexOf(id);
    return index < 0 ? preferred.length : index;
  };
  const rest = integrations
    .filter(
      (integration) =>
        choiceId.test(integration.id) &&
        !integration.id.startsWith("mcp_") &&
        !accountSources.some((source) => source.id === integration.id) &&
        canSignIn(integration),
    )
    .toSorted((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  for (const integration of rest) {
    const method = browserMethod(integration);
    const label = integration.name.slice(0, 128);
    choices.push(
      method?.id
        ? {
            id: integration.id,
            label,
            ...note(integration.id),
            route: {
              kind: "browser",
              integration: integration.id,
              method: method.id,
              fields: method.form ?? [],
            },
          }
        : {
            id: integration.id,
            label,
            ...note(integration.id),
            route: { kind: "terminal", integration: integration.id },
          },
    );
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
