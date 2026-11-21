# Spade: the product plan

Date: 2026-11-20. Owner: the founder. Status: draft for the founder's review. Covers Spade, the
agent OS ([ADR 0200](../adr/0200-spade-is-an-agent-operating-system.md)), and its store (the
market, ADRs 0168, 0174), from today to a Spade people pay for.

Decisions this plan rests on, all accepted 2026-11-20:
[0201](../adr/0201-spade-agent-format-is-an-open-standard.md) the open format,
[0202](../adr/0202-spade-bridges-to-shared-agent-standards.md) bridges to MCP, MCP Apps, skills
and A2A, [0203](../adr/0203-spade-packages-ship-sandboxed-webassembly.md) WebAssembly in
packages, [0204](../adr/0204-spade-measures-agent-quality-on-real-work.md) quality on real work,
[0205](../adr/0205-spade-bots-think-with-models-the-person-controls.md) model access. A hosted
always-on runner is approved in principle and planned later
([placeholder](../adr/drafts/spade-hosted-runner.md)).

## 1. Where Spade stands

**Built and reviewed:** bots with goals, plans and a separate check of done; routines, wakes and
owned services; an OS sandbox per bot with an egress proxy; effects declared per tool and decided
on; a small classifier and a reviewer; packages (`bot.json` v3) with a ceiling of declared effects
that binds even in Full access, install switches, linked updates and rollback, withdrawals;
`spade.v1`; cards, panels and contracts; the Running page; the dev kit; a signed market with a
fail-closed scanner; bot moves across the person's machines.

**Not proven:**

- Nothing has run end to end on a release build, on real models, for days, with updates and
  rollbacks. Every package test so far runs on a scripted model: it proves wiring, not behaviour.
- The full test suite hasn't been run on main since the Spade waves merged.
- No outside pen test, red team or bug bounty.
- No outside publishers, and no outside users of packages.
- Always-on is false: a bot on a laptop stops when the laptop sleeps.
- Many bots think with the person's coding subscriptions, whose terms may not allow it
  (ADR 0205 answers this).

**The market around it.** Model vendors bundle hosted agents into the subscriptions people
already pay for, so they own consumer distribution. Open, self-hosted agent registries have
shipped malicious skills. No consumer agent store has a working seller economy yet. The field
is settling on MCP for tools, `SKILL.md` folders for skills and agent-to-agent protocols for
calls. The opening that is realistic is narrow: trusted, self-hosted, maintained agents for
technical operators, small teams and privacy-sensitive firms, sold on the runtime and team
controls. The store is distribution, not the first product.

## 2. The beachhead

One buyer, one recurring job worth paying for.

### Candidate A: the small software team's overnight engineering desk (recommended)

- **Buyer.** The lead of a 3 to 20 person software team that already uses coding agents. Often a
  founder-engineer. Pays with a company card, decides alone.
- **The job.** "Each morning, know what broke overnight, what is waiting on me, and have the
  first fixes drafted." Every day, all year.
- **Why Spade wins here.**
  - ace already drives the team's coding agents, so a bot can hand a fix to one (`delegate`) and
    the person reviews a thread, not a chat message.
  - The work touches code, CI logs and error reports that teams don't want in a vendor's cloud.
  - The ceiling and the person-only effects are exactly what a lead wants before a bot touches
    the repository: it drafts, the person pushes.
  - These buyers will run a small always-on box, and read a terms note.
- **Weakness.** Technical buyers are few per company and have many tools. Price must match
  hours saved per week, not seats of the whole company.

### Candidate B: the privacy-sensitive small firm's document desk

- **Buyer.** A partner or office manager at a 5 to 50 person accounting, legal or clinic office.
- **The job.** "Every client document and mail is read, filed, its deadlines noted and a reply
  drafted, without our data leaving our machines."
- **Why it is attractive.** Willingness to pay for privacy is high. Local models (ADR 0205) make
  the promise real.
- **Why not first.** ace is a coding environment today; this buyer needs a different first run,
  support by phone, compliance claims Spade can't make yet, and connectors for mail and
  documents that work flawlessly on day one. The team features (M4) come first.

**Recommendation: A.** It reuses what ace already does best, its buyers tolerate today's rough
edges, and each package it needs is a direct use of contracts, cards, checks and `delegate`. B is
the second market, after M4, when local models and team controls exist.

### The first 10 first-party packages, for A

Each is a `spade-bot` v3 package by ace. "Calls" are contracts other packages use.

| #   | Package                   | What it does                                                                                                 | Triggers         | Effects it declares                                        | Calls it offers   |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------- | ----------------- |
| 1   | CI watcher                | Watches the default branch's CI; tells real failures from flaky ones; opens an ace thread with a drafted fix | schedule, event  | `network` (the git host), coding agent through `delegate`  | `ci_status`       |
| 2   | Dependency updater        | Weekly: reads advisories for the lockfiles; drafts an upgrade in an ace thread; the person pushes            | schedule         | `network` (advisory hosts), `send_as_person` (push, asked) | `open_advisories` |
| 3   | Issue triager             | Labels, de-duplicates and summarizes new issues; drafts replies the person sends                             | schedule         | `network`, `send_as_person` (comment, asked)               | `new_issues`      |
| 4   | Pull request shepherd     | Tracks open pull requests; finds stale ones and what blocks each; nudges as the person only when told        | schedule         | `network`, `send_as_person` (asked)                        | `pr_state`        |
| 5   | Error inbox               | Groups new errors from the team's error tracker or logs; links each to the commit that likely caused it      | schedule         | `network` (the tracker)                                    | `open_errors`     |
| 6   | Uptime checker            | Checks the endpoints the person names; a card with status and history; first code package (ADR 0203)         | schedule         | `network` (named hosts)                                    | `uptime`          |
| 7   | Release notes writer      | On a merge to the release branch or a tag, drafts the changelog and notes                                    | event, schedule  | `network`                                                  | `release_draft`   |
| 8   | Morning engineering brief | Calls 1 to 7 and writes one card at 8:00: what broke, what waits on you, what was drafted                    | schedule         | none beyond reads                                          |                   |
| 9   | Cloud spend watcher       | Reads the team's cloud billing exports; flags jumps with the likely cause                                    | schedule         | `network` (billing API)                                    | `spend_jumps`     |
| 10  | Incident scribe           | During an incident, keeps the timeline from threads and chat; drafts the post-mortem                         | message, mention | `network`                                                  |                   |

Every one ships scenario tests, `schema` checks on its contracts (ADR 0204), and is run by ace on
ace's own repositories for four weeks before it lists, with the results published as "its
publisher reports".

## 3. Milestones

In order. Each ends on a criterion anyone can check. Work in a later milestone doesn't start
until the one before has met its criterion, except where marked as running in parallel.

### M0: prove it

- **Work.** Run the full suite on main and fix it. Cut a signed release build for macOS and Linux.
  Run three of the first packages (CI watcher, Error inbox, Morning brief) on the founder's own
  machines with real endpoint models for seven days, then update each and roll each back. Hire an
  outside red team for two weeks, scoped to: escaping the sandbox; getting past the ceiling;
  injection through apps, pages, panels and contract calls; the market's supply chain (publish,
  scan, sign, update); panel isolation. Publish a security policy with a disclosure address and a
  paid bug bounty.
- **Exit criterion.** All of: the full suite (`bun run test`, `cargo test` in `spade/`, the process
  and slow tiers) passes at a tagged commit; the release build installs on two clean machines;
  the seven-day run's report is in `docs/verification/spade-m0/`, with each package's runs,
  verified-done rate, Stops, approvals per run and the update and rollback results; every critical
  and high finding from the red team is fixed or has an accepted ADR.

### M1: the beachhead and its first users

- **Work.** The ten packages of section 2. ADR 0205's first slice (endpoints and local models
  first, the terms record). ADR 0204's first slice (kept cases, free replays, schema checks).
  A guide for running Spade on a machine the team already keeps on (a Mac mini, a Linux box),
  using today's bot moves (ADR 0187), as the always-on host until M3. Twenty design-partner teams,
  invited, each with a 30-minute setup call.
- **Exit criterion.** At least 10 outside teams, on release builds, run at least three of the
  packages for four weeks in a row; each package has been updated and rolled back by at least one
  outside team; each package's verified-done rate per version is published from those teams'
  shared counts; median time from install to the first useful card is under 15 minutes.

### M2: the open format and the bridges

- **Work.** ADR 0201 phases 1 and 2 (spec site, schemas, conformance suite, `spade-conform`).
  ADR 0202 phases 1 and 2 (skills both ways, the MCP effect table, contracts out to MCP and A2A).
  A publisher guide and a small publisher program: ten invited outside publishers, with a
  maintainer's review within two working days.
- **Exit criterion.** Spade passes all three conformance levels in CI; at least 5 outside
  publishers have each listed a package, and at least 3 have shipped a second version; at least
  50 outside `SKILL.md` skills import and pass the scanner; at least one outside reader passes the
  Reader level.

### M3: always-on, and the iPhone

- **Work.** The hosted always-on runner, designed in its own ADR as a new exception to ADR 0002
  (see the placeholder), and built. Until it ships, the person's own always-on machine stays the
  path. iPhone parity for Spade: the Running page, cards, approvals, the install and update
  review, rollback, and the morning brief.
- **Exit criterion.** For outside users with laptops closed overnight, always-on bots fire at
  least 99% of scheduled runs within five minutes of their time over 30 days; an outside user
  installs, updates, rolls back and approves from the iPhone alone.

### M4: teams and organizations, and private registries

- **Work.** An organization in the ace account. Shared bots: one bot serving a team, its grants
  owned by the organization, its approvals answered by named members. Roles: admin, member. An
  organization ceiling: effects no bot of the organization may use, enforced by the same gate.
  An audit log of every outward effect, who allowed it and on which bot, exportable. Sign-in with
  the organization's identity provider (through the account backend). Private registries: an
  organization's own catalog of packages, signed with the organization's key, which its members'
  devices trust beside the market's keys.
- **Exit criterion.** Three paying pilot teams of at least five people each use shared bots for 30
  days; for every outward effect in those 30 days the audit log names who allowed it; a private
  package installs from an organization registry on every member's device and is refused on a
  device outside it.

### M5: code in packages

- **Work.** ADR 0203 phases 1 and 2. Uptime checker and two more first-party packages move logic
  into components. A second red team, scoped to `spade-wasm`, the host functions and the scanner.
- **Exit criterion.** Three first-party packages ship code; one outside publisher's code package
  passes review and lists; the red team finds no way out of a component to the network, the file
  system or another bot.

### M6: paid runtime, then paid listings

- **Work, first.** The paid Team plan (section 5): billing in the account, seats, the organization
  features of M4 behind it.
- **Work, second, its own ADR.** Paid listings: a price in the signed version manifest beside the
  hash (ADR 0200 §3.7), a licence per account checked on the device with an offline grace period,
  refunds, payouts, tax handled by a merchant of record, and a take rate (section 5).
- **Exit criterion.** The Team plan: at least 25 paying teams and 80% of them still paying after
  three months. Paid listings: at least 5 outside publishers paid out, with refunds working end
  to end.

### Running alongside every milestone

- **Quality.** ADR 0204's later phases land as M1 and M2 need them: model replays on update
  reviews by M1's end, evidence on listings by M2's.
- **Security operations.** The bounty stays open. Each release has a security note. Withdrawals
  are rehearsed once a quarter.
- **Support.** One channel, answered within a working day, for design partners and then for
  paying teams.

## 4. What to cut or freeze

Frozen means: kept working and fixed, no new features, until the milestone named.

| Item                                                                                 | Status                                                          | Until |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----- |
| The `ace-plugin` market type (0168 phase 3)                                          | Not started                                                     | M4    |
| Suits as a market product: new Suit features, outside Suit publishing campaigns      | Frozen                                                          | M2    |
| Ratings and written reviews (0200 phase 3)                                           | Not started                                                     | M2    |
| Trending, ranking tiers and discovery beyond search and Featured (0174 §6, §15)      | Frozen                                                          | M2    |
| Publisher verification beyond a manual check by a maintainer (0174 §13)              | Frozen                                                          | M2    |
| Paid listings and calls between different people's agents                            | Not started                                                     | M6    |
| Connector catalogue growth: no new apps beyond those the ten packages need           | Frozen                                                          | M2    |
| Panels beyond what is built; cards carry the beachhead                               | Frozen                                                          | M2    |
| Bots driving the computer, simulators and devices (`devices` module) in packages     | Frozen                                                          | M3    |
| Clubs: no new club features                                                          | Frozen                                                          | M4    |
| Character faces, 3D and other cosmetic Spade work                                    | Frozen                                                          | M3    |
| Voice in Spade                                                                       | Frozen                                                          | M3    |
| Spade on Windows as an always-on host; networked runs under the Windows sandbox      | Frozen; Windows stays a client and runs bots on the review path | M5    |
| Android work for Spade                                                               | Frozen                                                          | M3    |
| Spade Cloud's "managed Spade" direction (0140 §6), except as the hosted runner's ADR | Frozen                                                          | M3    |
| Webhooks reached from outside the machine                                            | Not started                                                     | M3    |

## 5. Pricing hypothesis

**What is sold first is the runtime's team controls, not the agents.** Free packages stay free.

| Plan     | Price to test                            | What it holds                                                                                                                            |
| -------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Personal | Free                                     | All of Spade on the person's own machines: unlimited bots, every free package, routes, local models, replays                             |
| Team     | $24 per seat per month, at least 3 seats | Shared bots, the organization ceiling, the audit log, sign-in with the organization's provider, a private registry, fleet administration |
| Runner   | To price in its ADR                      | The hosted always-on runner (M3), priced by bot-hours, with the person's own model keys                                                  |

- **Test against an alternative:** $49 per always-on host per month, any number of seats. Offer
  each to half of the M1 design partners at the end of their four weeks, and compare conversion.
- **Paid listings (M6):** the publisher sets the price, a monthly subscription per seat or a one-off
  price. Take rate: 15% of the price, 0% on free listings, so publishers keep more than in the
  stores they know. Revisit once there are 20 paid listings.

**Metrics that show it works**, read from opt-in counts (ADR 0204), the market and the account:

| Metric                   | Definition                                                                                                             | Target by M1's end |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Activation               | Installs whose bot gives a first useful result (a card or notice the person opens, or a verified goal) within 24 hours | 60%                |
| Weekly repeat runs       | Installed bots with at least three runs in a week whose result the person opened                                       | 40% at week 4      |
| Installs per package     | Installs per first-party package, and the share still running (not paused or removed) after four weeks                 | 50% still running  |
| Verified-done rate       | ADR 0159's done verdicts over claims, per package version                                                              | 80%                |
| Friction                 | Approvals the person answered per run, median                                                                          | 1 or fewer         |
| Rollbacks                | Updates rolled back                                                                                                    | under 5%           |
| Publisher retention (M2) | Outside publishers who ship a second version within 60 days                                                            | 50%                |
| Pilot conversion (M4)    | Pilot teams that pay at the end of the pilot                                                                           | 30%                |

## 6. Risks, and what retires each

| Risk                                                | What retires it                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Nothing works end to end on real models             | M0's seven-day run and published report                                                                      |
| A malicious or broken package hurts someone         | The ceiling, held runnable content, M0 and M5 red teams, the bounty, rehearsed withdrawals                   |
| Model vendors' bundled agents take the whole market | A narrow beachhead where self-hosting, coding agents and team controls matter; the open format               |
| Coding subscriptions' terms forbid bots             | ADR 0205: endpoints and local models first, the terms record, the paid plan never depending on them          |
| Always-on is false                                  | M1's own-machine guide, then M3's hosted runner                                                              |
| No outside publishers                               | ADR 0201 and 0202 (one format others can run, imported skills and MCP tools), M2's publisher program         |
| People can't tell a good bot from a bad one         | ADR 0204: replays on their own work, checks, evidence on listings                                            |
| Packages can't do enough without code               | ADR 0203 in M5                                                                                               |
| The scope outgrows one team                         | Section 4's freezes, and the rule that a milestone starts only after the last one's criterion is met         |
| Teams need compliance claims Spade can't make       | M4's audit log and organization ceiling; data that stays on the team's machines narrows what must be audited |
| The hosted runner breaks ADR 0002's promise         | Its own ADR, which states every clause it amends, before anything is built                                   |

## 7. Decisions still the founder's

At most eight, each with a recommendation.

1. **The beachhead.** Recommended: A, the small software team's overnight engineering desk.
2. **The ten packages.** Recommended: section 2's list, with CI watcher, Error inbox and Morning
   brief as M0's three.
3. **The freezes.** Recommended: section 4 as written.
4. **The red team.** Recommended: an outside firm for two weeks in M0 and again in M5, and a paid
   bounty from M0, with a budget the founder sets.
5. **Design partners.** Recommended: 20 invited teams, free during M1, in exchange for sharing
   counts and a weekly 15-minute call.
6. **Price to test.** Recommended: $24 per seat per month (at least three), tested against $49 per
   always-on host.
7. **Take rate for paid listings.** Recommended: 15%, 0% on free, revisited at 20 paid listings.
8. **When to design the hosted runner.** Recommended: write its ADR during M2, so it can be built
   in M3, with endpoint keys and ace-provided models only and no coding-CLI logins on ace's
   machines.
