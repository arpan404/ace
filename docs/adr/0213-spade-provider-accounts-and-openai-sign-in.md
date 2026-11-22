# 0213: Spade holds several accounts per provider and signs in to OpenAI itself

Status: accepted. Date: 2026-11-22. Decided by: the owner (2026-11-22: "Spade signs in to
OpenAI", chosen over running bots through the installed Codex CLI; accounts cover "several per
provider"; "spade providers, models management all in spade settings part"). Overturns part of
[ADR 0002](0002-local-cli-providers.md) and the first option of
[ADR 0133](0133-spade-cli-brains.md); extends the exception in
[ADR 0119](0119-spade-endpoint-keys.md). The API is in
[spade/docs/agents.md](../../spade/docs/agents.md), "Providers and accounts".

## Context

ADR 0002 says ace reaches providers only through the person's installed, logged-in CLIs and never
collects or stores provider credentials. ADR 0119 made one exception: Spade keeps the API keys of
endpoints the person adds, in the OS keychain only. ADR 0133 then let a bot think with a
subscription through its CLI, and listed "read the CLI's login and call the provider from Spade"
as forbidden.

Two things are now wanted. People hold more than one account with the same provider (a personal
and a work OpenAI key, two ChatGPT plans) and want each bot to pick which one pays. And the owner
wants Spade to sign in to OpenAI with a ChatGPT account directly, the way OpenAI's own Codex
clients do, rather than only through the Codex CLI.

## Decision

1. **An account is an endpoint.** Spade's endpoints (ADR 0126) already have their own id, key and
   models, and nothing stopped two from the same preset. Each one is now shown as an *account* of
   a *provider*: the preset it was made from (`openai`, `anthropic`, `opencode-go`, …), or its
   own address for one added from scratch. A provider holds any number of accounts. An account
   signs in one of three ways: an API key (ADR 0119), none (a local server), or a ChatGPT
   sign-in (below).
2. **The reference names the account.** A model reference stays `<account>/<model>`, where
   `<account>` is the endpoint id: unique across every provider, picked when the account is added
   (a slug of its name, `-2` and on when taken) and never changed after. Renaming an account
   changes only the name people see. So every reference stored before this
   (`opencode-go/deepseek-v4.1-flash`, a bot's model, a role's model, a default) reads as it did,
   with no migration and no rewrite of history (ADR 0170). A ChatGPT sign-in account's id is
   `chatgpt`, then `chatgpt-2` and on. Subscriptions through a CLI keep
   `cli:<provider>@<account>/<model>` (ADR 0133) unchanged; those accounts stay ace's
   (ADR 0018, 0138) and Spade does not copy them.
3. **Spade signs in to OpenAI.** Spade runs OpenAI's sign-in for ChatGPT accounts itself: a
   browser sign-in with PKCE and a loopback callback on the machine Spade runs on, and a device
   code for a Spade with no browser near it (a server, or a machine reached over the ace
   connection). Refresh happens in Spade when the access token nears its end. Each signed-in
   ChatGPT account is its own account, shown with its email and plan; signing in again with the
   same ChatGPT account renews that account instead of adding a second. Its models are the ones
   that account's backend lists for it. Calls go to the ChatGPT backend's Responses route with
   the account's token. Usage and limit errors are read leniently and shown as one plain line
   ("This ChatGPT account reached its usage limit; it resets at 14:00.").
4. **Where sign-in tokens live: the keychain only.** ADR 0119's exception now covers OAuth
   tokens Spade obtains itself: stored in the OS credential store under
   `oauth:<account>:access` and `oauth:<account>:refresh`, held in memory while in use, and never
   written to SQLite, the event log, logs, traces, crash reports, settings files or sync, never
   returned by any API, and never sent to the relay or ace's cloud. Only facts that are not
   secrets (email, plan, the ChatGPT account id) are kept in Spade's database. Signing out deletes
   the tokens and keeps the account, so bots on it say "signed out" until the person signs in
   again; removing the account deletes both. Tests use `keyring-core`'s mock store and a local
   fake sign-in server, never a real keychain or a real OpenAI login.
5. **The person opts in knowingly.** Using a ChatGPT sign-in outside OpenAI's own Codex clients
   may conflict with OpenAI's terms. The sign-in screen says so in one plain sentence, and Spade
   refuses to start a sign-in the person has not confirmed (`terms_read: true`). The CLI route
   (ADR 0133) stays for anyone who would rather not.
6. **All of it lives in Spade's settings.** Settings › Spade › Models lists providers, each with
   its accounts (add, rename, remove, sign in and out, which bots use it) and each account's
   models; the defaults (new bots, fast work, roles) pick from them. Each bot and each role picks
   an account's model, so it picks provider, account and model at once.

## Consequences

- Two keys for one provider, or two ChatGPT plans, can run side by side, each bot choosing.
- OpenAI may change or refuse the ChatGPT backend for clients other than its own at any time; a
  refused call ends as one line like any other model failure, and a bot can be moved to another
  account.
- Spade now holds long-lived refresh tokens in the keychain. A leak of the keychain entry is a
  leak of the ChatGPT session, as with any app that keeps one; signing out removes it.
- ADR 0002 still holds for everything else: ace's coding sessions run through the person's CLIs,
  and Spade never reads a CLI's login.
