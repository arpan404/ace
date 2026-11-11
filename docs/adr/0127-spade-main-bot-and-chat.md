# 0127: Spade is the main bot among the person's bots, shown as a chat

Status: accepted. Date: 2026-11-11. Decided by: the owner (2026-11-11: "Spade will be the main bot
and the others will be the other bots ... they will all run in the same machine or the user can
choose different machine for different bot", "we will have chat bubbles instead of the markdown
full render", "we will only show the status of the current one with the pulsating eye thing ... we
don't show any background work ... the agent will be autonomous"). Amends
[ADR 0126](0126-spade-agents.md), decisions 1 to 3; the rest of 0126 stands.

## Context

ADR 0126 made Spade a set of equal agents. The owner refined it the same day: one main bot,
Spade, with secondary bots beside it, the way current agent products organise persistent named
workers (each owns its job end to end and comes back only when it needs the person; a
coordinating bot hands work to specialists; the roster shows each bot's latest message; the
bot's own face shows whether it is idle, working or waiting instead of a step log). ace's thread
view renders every tool call and full Markdown, which suits supervising a coding agent but not
delegating to an autonomous one.

## Decision

1. **Spade is the main bot; every other agent is a bot.** Spade always exists, cannot be deleted,
   and is the person's first contact; its task is editable, its name is Spade and its face is the
   Spade mark. Bots are created by the person (name, task, avatar, model, as ADR 0126 says) and
   can be edited and deleted. Spade can hand work to bots and ask them questions; a message to a
   bot wakes it, and its answer comes back to whoever asked.

2. **Each bot runs on a machine the person picks.** The creation form offers the person's
   machines that run Spade's service, this machine first. A bot lives in that machine's Spade
   service, with that machine's files, browser and ace. Spade, the main bot, lives on the first
   machine where Spade was turned on. The app lists the bots of every machine it reaches; a
   machine that is offline shows its bots as away. Bots on the same machine talk directly;
   reaching a bot on another machine goes through ace's paths between machines and is built
   after same-machine handoffs.

3. **The app is a chat.** The sidebar is a list of conversations like a messenger: each bot's
   face, name, its latest message or current status, and time; Spade first. A conversation shows
   the person's messages and the bot's messages as bubbles, with light formatting (links, code,
   lists) inside a bubble, not the full document rendering of threads.

4. **Only the current state shows.** While a bot works, one line under its last bubble shows its
   face with animated eyes and a few words on what it is doing now. Tool calls, background jobs,
   sub-agents and compaction are not shown; they belong to the bot. When a bot needs the person
   (an approval, a question), that arrives as a message bubble with text buttons.

## Consequences

- The person delegates instead of supervising; the cost is less visibility into a bot's steps
  (kept in Spade's stored events for debugging, not in the chat).
- Spade's API reports each bot's current state (idle, working, waiting on the person) and a short
  status text, and each conversation's latest message, so the roster needs no transcript loads.
- Spade gains tools to list bots and message them on its machine.
- Cross-machine bots need the app to reach several machines' Spade services, through each
  machine's daemon as ADR 0123 decision 9 already allows.

## Tests

- Spade exists on first start, cannot be deleted, and lists in the roster first.
- A bot created for another machine is stored by that machine's Spade and listed with it.
- A conversation renders bubbles for both sides and no tool calls; while working, one status line
  with the animated face shows, and it goes when the reply ends.
- An approval arrives as a bubble whose buttons answer it.
- Spade asks a bot on the same machine; the bot wakes, answers, and the answer reaches Spade.
