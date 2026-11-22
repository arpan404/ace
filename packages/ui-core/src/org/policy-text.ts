import { AceOrgPolicy } from "@ace/protocol/ace-org";

/*
 * An organization's policy as its admins edit it (ADR 0206 §3), pure: the stored text read as a
 * policy, and its lists as lines of text. Web and the iPhone both edit through these, so a list
 * saved on one reads the same on the other. A policy only narrows, so a part ace can't read is
 * shown as unset and left as it was.
 */

/** The stored version's text as a policy; a text this build can't read is no ceiling of its own. */
export function readPolicy(body: string): AceOrgPolicy {
  try {
    const parsed = AceOrgPolicy.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Lines of a list field: trimmed, blank ones dropped, each once. */
export function lines(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

type Allow = NonNullable<NonNullable<AceOrgPolicy["packages"]>["allow"]>[number];
type Block = NonNullable<NonNullable<AceOrgPolicy["packages"]>["block"]>[number];
const sourceOf = (word: string): Allow["source"] | undefined =>
  word === "market" || word === "registry" || word === "git" ? word : undefined;

/** "market spade-bot/ci-watcher" per line; a line without a known source is from the market. */
export function allowEntries(text: string): Allow[] {
  return lines(text).map((line) => {
    const [first = "", ...rest] = line.split(/\s+/);
    const source = sourceOf(first);
    if (source && rest.length > 0) return { source, name: rest.join(" ") };
    return { source: "market", name: line };
  });
}
export const allowText = (allow: readonly Allow[] | undefined) =>
  (allow ?? []).map((entry) => `${entry.source} ${entry.name}`).join("\n");

/** A `sha256:…` line blocks that exact archive; any other line blocks a package by name. */
export function blockEntries(text: string): Block[] {
  return lines(text).map((line) =>
    /^sha256:[0-9a-f]{64}$/.test(line) ? { hash: line } : { name: line },
  );
}
export const blockText = (block: readonly Block[] | undefined) =>
  (block ?? []).map((entry) => ("hash" in entry ? entry.hash : entry.name)).join("\n");

/** The policy as a page edits it: the stored one, with its three lists as lines of text. */
export interface PolicyDraft {
  policy: AceOrgPolicy;
  allow: string;
  block: string;
  endpoints: string;
}

export function policyDraft(policy: AceOrgPolicy): PolicyDraft {
  return {
    policy,
    allow: allowText(policy.packages?.allow),
    block: blockText(policy.packages?.block),
    endpoints: (policy.models?.endpoints ?? []).join("\n"),
  };
}

/** The draft as the next version: its lists from their lines, an empty list left out. */
export function policyFromDraft(draft: PolicyDraft): AceOrgPolicy {
  const allow = allowEntries(draft.allow);
  const block = blockEntries(draft.block);
  const endpoints = lines(draft.endpoints);
  const { packages, models } = draft.policy;
  return {
    ...draft.policy,
    packages: {
      ...packages,
      ...(allow.length ? { allow } : { allow: undefined }),
      ...(block.length ? { block } : { block: undefined }),
    },
    models: {
      ...models,
      ...(endpoints.length ? { endpoints } : { endpoints: undefined }),
      // Shared bots never think on a member's coding subscription in M4.
      subscriptions: false,
    },
  };
}
