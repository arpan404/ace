import type { CliOutcome } from "@ace/protocol/cli-output";
import type { TopicSpec } from "../commands/spec.ts";

/** What each exit code means (ADR 0178 §4); `ace help exit-codes` and `help --json` print it. */
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
  - Agents never answer requests. Approvals, questions to the person, plans and
    permissions are the person's: ace request allow|deny|answer, ace config set|unset and
    ace feature|spade on|off exit 2 (code person_only) from your shell. Hand back to the
    person instead; they answer in the app, on a paired device or in their own terminal.
  - In the market you may read, search, check, make and publish drafts, and read your
    status and versions. Everything else (installing, removing, withdrawing, transfers,
    sources, listings, visibility) is the person's and becomes a request in your thread
    (ace help publishing).`,
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
    text: `  ace market check ./my-suit --type suit                 the market's checks, here
  ace market publish suit ./my-suit --version 1.2.0 --draft
                                                         a draft and its scan
  ace market draft publish DRAFT                         publish it
  ace market status                                      your entries and their versions
  ace market describe suit/my-suit --title "My Suit"     the listing's words

Publishing needs this machine signed in to your ace account (ace login). Withdrawing,
transferring, handle changes, editing a verified profile and verification ask you to sign
in again first (exit 2, code reauth, without a terminal).

From an agent (ACE_THREAD_ID set, or ace's market_publish tool), publishing follows your
provider's permissions. Withdraw, transfer, handle changes, deleting an entry, verified
profile edits, verification and installing are yours: ace asks you in the agent's thread
and the command exits 2 with code person_only and the request's id; --yes doesn't change
that. Settings › Beta › Ask me before agents publish makes every agent publish such a
request too.`,
  },
  {
    name: "market-maintainer",
    summary: "The market's maintainer tools",
    text: `Maintainer tool: needs ACE_MARKET_SIGNER_TOKEN and a signing key.

ace market maintainer COMMAND talks to market.acehq.dev directly, never through the daemon
or an ace account, and sends the signer token there only. A development market must be
named with --dev-market URL (https, or http on this machine). --json and --jq work as
everywhere.

  keygen KEY_FILE [--id ID]            a signing key; prints its public half
  sign --key KEY_FILE                  re-scan, then sign, hold or block what waits
  review [TYPE/NAME@VERSION]           the queue, or one version: --show, --approve, --block
  feature TYPE/NAME…                   the featured list
  revoke HASH --reason TEXT            withdraw bytes wherever they're listed
  reports [resolve ID --state STATE]   open reports
  collection list|put|remove           curated collections
  publisher HANDLE --suspend|--restore|--withdraw-all
  block|block-file|block-pattern       the signed blocklist
  appeals | appeal ID --answer TEXT --approve|--keep
  verify|unverify HANDLE --reason TEXT
  official add|remove ACCOUNT
  notice PROVIDER allowed|unclear|refused --note TEXT
                                       a subscription's terms change; devices only tighten

The old ace market VERB spellings still work for now.`,
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
