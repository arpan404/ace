import type { ArgSpec, CommandSpec, FlagSpec } from "./spec.ts";

/*
 * Publishing (ADR 0176 §12.1): each command is one `publish` action of `MarketPublishAction`.
 * Publishing needs this machine signed in to an ace account; the sensitive ones (withdraw,
 * transfer, handle, verified profile, verification) need a recent sign-in. From an agent, those
 * and deleting an entry are the person's: ace asks them in the agent's thread.
 */

const entry: ArgSpec = {
  name: "REF",
  summary: "TYPE/NAME, such as suit/dusk-harbor",
  required: true,
};
const version: ArgSpec = { name: "REF", summary: "TYPE/NAME@VERSION", required: true };
const draftId: ArgSpec = { name: "DRAFT", summary: "The draft's id (drf_…)", required: true };
const wait: FlagSpec = { name: "wait", summary: "Watch until it is live, or blocked" };
const changelog: FlagSpec = {
  name: "changelog",
  value: "TEXT",
  summary: "What changed: the text, - for stdin, or @FILE",
};
const personOnly = { code: 2, when: "from an agent: it's the person's; ace asked them" };

function command(
  verb: readonly string[],
  summary: string,
  rest: Partial<CommandSpec> = {},
): CommandSpec {
  return {
    id: ["market", ...verb].join("."),
    words: ["market", ...verb],
    summary,
    group: "spade-market",
    output: "market.publish",
    ...rest,
  };
}
const mutation = (
  verb: readonly string[],
  summary: string,
  rest: Partial<CommandSpec> = {},
): CommandSpec => command(verb, summary, { mutates: true, ...rest });

export const marketPublishCommands: readonly CommandSpec[] = [
  mutation(["publish"], "Upload a version as a draft, read its scan, then publish it", {
    args: [
      { name: "TYPE", summary: "suit, spade-skill, spade-plugin or spade-bot", required: true },
      { name: "PATH", summary: "A folder, or one of your Suits by id", required: true },
    ],
    flags: [
      { name: "name", value: "NAME", summary: "The entry's name; the folder's otherwise" },
      { name: "version", value: "VERSION", summary: "The version to publish, such as 1.2.0" },
      changelog,
      { name: "draft", summary: "Stop at the draft and print its id" },
      { name: "unlisted", summary: "Reached by its link, not by search" },
      wait,
    ],
    examples: [
      {
        command: "ace market publish suit ./dusk-harbor --version 1.2.0 --draft",
        summary: "A draft and its scan",
      },
    ],
    exits: [
      { code: 1, when: "a check found a problem, or the scan blocked it" },
      { code: 2, when: "signed out, or it needs your yes" },
    ],
  }),
  command(["draft", "list"], "Your drafts", { nounDefault: true }),
  command(["draft", "show"], "One draft and its scan", { args: [draftId] }),
  mutation(["draft", "update"], "Change a draft's version, changelog or files", {
    args: [draftId],
    flags: [
      { name: "version", value: "VERSION", summary: "Another version" },
      changelog,
      { name: "from", value: "PATH", summary: "New files from this folder" },
    ],
  }),
  mutation(["draft", "publish"], "Publish a draft", { args: [draftId], flags: [wait] }),
  mutation(["draft", "delete"], "Delete a draft", { args: [draftId] }),
  command(["status"], "Your entries, and where each version is", {
    args: [{ name: "REF", summary: "One entry: TYPE/NAME" }],
  }),
  command(["versions"], "One entry's versions with status, changelog and deprecation", {
    args: [entry],
  }),
  mutation(["describe"], "Change an entry's listing words", {
    args: [entry],
    flags: [
      { name: "title", value: "TEXT", summary: "Its title" },
      { name: "line", value: "TEXT", summary: "Its one line" },
      { name: "description", value: "TEXT", summary: "Its description, or @FILE" },
      { name: "category", value: "CATEGORY", summary: "A category (up to 3)", repeat: true },
      { name: "keyword", value: "WORD", summary: "A keyword (up to 16)", repeat: true },
      { name: "link", value: "LABEL=URL", summary: "A link (up to 5)", repeat: true },
    ],
  }),
  mutation(["changelog"], "Set one version's changelog", {
    args: [version, { name: "TEXT", summary: "The text, - for stdin, or @FILE", stdin: true }],
  }),
  mutation(["latest"], "Which version the listing shows", {
    args: [entry, { name: "VERSION", summary: "The version; --newest follows the newest" }],
    flags: [{ name: "newest", summary: "Follow the newest live version" }],
  }),
  mutation(["deprecate"], "Deprecate a version, with a note installs show", {
    args: [version],
    flags: [
      { name: "note", value: "TEXT", summary: "Why, and what to use instead" },
      { name: "clear", summary: "Clear the deprecation" },
    ],
  }),
  mutation(["visibility"], "Listed in search, or reached by its link only", {
    args: [entry, { name: "VISIBILITY", summary: "listed or unlisted", required: true }],
  }),
  mutation(["archive"], "Hide an entry from search; installs keep working", { args: [entry] }),
  mutation(["unarchive"], "List an archived entry again", { args: [entry] }),
  mutation(["withdraw"], "Withdraw a version, or every version, from everyone's devices", {
    args: [{ name: "REF", summary: "TYPE/NAME@VERSION, or TYPE/NAME for all", required: true }],
    flags: [{ name: "reason", value: "TEXT", summary: "Why; devices show it" }],
    exits: [personOnly],
  }),
  mutation(["transfer"], "Offer an entry to another publisher", {
    args: [entry],
    flags: [{ name: "to", value: "@HANDLE", summary: "Who receives it" }],
    exits: [personOnly],
  }),
  mutation(["transfer", "accept"], "Accept a transfer offered to you", {
    args: [{ name: "TRANSFER", summary: "The transfer's id (trf_…)", required: true }],
    exits: [personOnly],
  }),
  mutation(["transfer", "decline"], "Decline a transfer offered to you", {
    args: [{ name: "TRANSFER", summary: "The transfer's id (trf_…)", required: true }],
    exits: [personOnly],
  }),
  mutation(["delete"], "Delete an entry that only ever had drafts or was never listed", {
    args: [entry],
    exits: [personOnly],
  }),
  command(["signals"], "Downloads, installs and reports for one entry", { args: [entry] }),
  mutation(["appeal"], "Ask ace's maintainers to look again at a held or blocked version", {
    args: [{ name: "REF", summary: "TYPE/NAME@VERSION", required: true }],
    flags: [
      { name: "note", value: "TEXT", summary: "What you changed, or why it's fine" },
      { name: "replacement", value: "VERSION", summary: "A newer version that answers it" },
      // `ace market appeal ID --answer …` is the maintainer's, for the deprecation window.
      { name: "answer", value: "TEXT", summary: "Maintainer: your answer", hidden: true },
      { name: "approve", summary: "Maintainer: approve", hidden: true },
      { name: "keep", summary: "Maintainer: keep the decision", hidden: true },
      { name: "url", value: "URL", summary: "Maintainer: another market origin", hidden: true },
    ],
  }),
  command(["profile", "show"], "Your publisher profile", { nounDefault: true }),
  mutation(["profile", "create"], "Make your publisher profile", {
    flags: [
      { name: "handle", value: "HANDLE", summary: "Your handle, such as arpan" },
      { name: "name", value: "NAME", summary: "The name people see" },
      { name: "bio", value: "TEXT", summary: "A line about you" },
    ],
  }),
  mutation(["profile", "edit"], "Change your profile's name or bio", {
    flags: [
      { name: "name", value: "NAME", summary: "The name people see" },
      { name: "bio", value: "TEXT", summary: "A line about you" },
    ],
    exits: [personOnly],
  }),
  mutation(["profile", "handle"], "Change your handle", {
    args: [{ name: "HANDLE", summary: "The new handle", required: true }],
    exits: [personOnly],
  }),
  mutation(["profile", "avatar"], "Set your profile picture", {
    args: [{ name: "FILE", summary: "A PNG, JPEG or WebP, at most 1 MB", required: true }],
  }),
  mutation(["profile", "pins"], "Pin up to six of your entries on your page", {
    args: [{ name: "REF", summary: "TYPE/NAME, in order", variadic: true }],
  }),
  command(["verification", "show"], "Your verification and its proofs", { nounDefault: true }),
  mutation(["verification", "apply"], "Apply for ace's verified mark", {
    flags: [
      { name: "domain", value: "DOMAIN", summary: "A domain you own" },
      { name: "github", value: "LOGIN", summary: "Your GitHub login" },
    ],
    exits: [personOnly],
  }),
  mutation(["verification", "check"], "Check your proofs again now", { exits: [personOnly] }),
];
