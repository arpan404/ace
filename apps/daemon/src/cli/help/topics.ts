import type { CliOutcome } from "@ace/protocol/cli-output";
import type { TopicSpec } from "../commands/spec.ts";

/** What each exit code means (ADR 0176 §4); `ace help exit-codes` and `help --json` print it. */
export const exitCodeMeanings: readonly { code: number; name: CliOutcome; means: string }[] = [
  { code: 0, name: "ok", means: "Done" },
  { code: 1, name: "failed", means: "The work or check failed" },
  { code: 2, name: "needs-human", means: "A person must act: a request is open, or sign-in" },
  { code: 3, name: "timeout", means: "Stopped watching; the work may still run" },
  { code: 4, name: "refused", means: "ace understood and said no: not allowed, not found, off" },
  { code: 5, name: "uncertain", means: "Not known whether it happened; retry with the same key" },
  { code: 6, name: "address-in-use", means: "ace start: the port is taken" },
  { code: 7, name: "lock-held", means: "ace start: another daemon holds this ace home" },
  { code: 64, name: "usage", means: "The command line was wrong" },
  { code: 65, name: "newer-data", means: "A newer ace wrote this home" },
  { code: 66, name: "incompatible-data", means: "A store is in a format this build can't read" },
];

export const topics: readonly TopicSpec[] = [
  {
    name: "output",
    summary: "Human text, --json, --quiet and streams",
    text: `Every command prints words for a person by default, piped or not.

  --json        exactly one JSON value on stdout: the command's data, or a CliError
                ({ok:false, status, code, error, hint}) when it fails. Progress and
                notices go to stderr. No colour codes, ever.
  --jq EXPR     --json filtered through the installed jq.
  --quiet, -q   only identifiers, one per line (thread ids, request ids, entry refs);
                actions print nothing. Errors still go to stderr.
  --follow, -f  keep printing as things change; JSON Lines with --json, ending in a
                record of type "outcome".
  --no-input    never ask anything; a missing argument is a usage error (exit 64).
  --color WHEN  auto, always or never. auto follows the terminal, NO_COLOR, FORCE_COLOR.

ace help COMMAND --schema prints a command's --json shape as JSON Schema.
ace help --json prints every command, flag and exit code.`,
  },
  {
    name: "exit-codes",
    summary: "What each exit code means",
    text: "",
  },
  {
    name: "agents",
    summary: "How agents running inside ace should call it",
    text: `ace starts your session with ACE_THREAD_ID (your thread) and ACE_NO_INPUT=1, so
nothing ever waits for input and tools like ace sim and ace browser know your thread.

  - Check the exit code before reading the output. 2 means hand back to the person.
  - Use --json to parse, and human text to read: it is shorter.
  - 64 means the command line was wrong; the error names the argument and the fix.
  - 5 means ace doesn't know whether it ran: retry with the same --idempotency-key.
  - A missing prompt is read from stdin only when you pass -.
  - Waits never report done while any agent in a tree works or waits on a person.
  - Publishing to the market is yours to do; withdrawing, transferring, deleting and
    installing are the person's, and become a request in your thread (ace help publishing).`,
  },
  {
    name: "remote",
    summary: "Working on another machine",
    text: `Pair another machine with ace device pair there, then here:

  ace remote add work --link URL   save it as a profile
  ace remote use work              every later command goes there
  ace thread list --remote work    or just one command
  ace remote use local             back to this machine

On a remote, --project takes a project id from ace project list; paths are refused.`,
  },
  {
    name: "publishing",
    summary: "Publishing Suits, skills and bots to the market",
    text: `  ace market check ./my-suit --type suit     the market's checks, locally
  ace market publish suit ./my-suit --draft  upload a draft and read its scan
  ace market draft publish DRAFT             publish it
  ace market status                          your entries and where each version is

Publishing needs this machine signed in to your ace account (ace login). Withdrawing,
transferring and handle changes ask you to sign in again first.`,
  },
  {
    name: "market-maintainer",
    summary: "The market's maintainer tools",
    text: `Maintainer tools: ace market maintainer COMMAND. They need ACE_MARKET_SIGNER_TOKEN and a
signing key, and talk to market.acehq.dev directly, never through the daemon.

  keygen sign review feature revoke reports collection publisher block block-file
  block-pattern appeals appeal verify unverify official

ace help market maintainer COMMAND for one.`,
  },
  {
    name: "scripting",
    summary: "Using ace from scripts",
    text: `  id=$(ace run "Fix the build" --quiet)        the new thread's id
  ace thread wait "$id" --tree --timeout 30m   exit 0 done, 1 failed, 2 needs you
  ace request list --quiet                     what's waiting, one id per line
  ace thread list --json --jq '.threads[].id'

Mutations take --idempotency-key KEY: the same key never runs twice, so a retry after
exit 5 is safe.`,
  },
];
