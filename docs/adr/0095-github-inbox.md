# 0095: GitHub notifications inbox

Date: 2026-10-22. Status: accepted.

## Context

ace already shows a project's pull requests and issues as pages (ADR 0016 and its later
sections). The main remaining reason to open github.com during the day is its notifications:
review requests, mentions, replies, assignments and CI results. They belong to the signed-in
account, not to one repository, and GitHub limits how often a client may ask for them.

## Decision

ace reads and changes the account's notifications through the person's own `gh`, as every
other forge call does. ace never reads, stores or proxies a credential (ADR 0002).

### Reads

`forge.inbox.list` (a `workspace.request` forge read) asks
`GET /notifications` with `all`, `participating`, `since`, `per_page=50` and `page`, or
`GET /repos/{owner}/{name}/notifications` when one repository is chosen. The project in the
request only names the host: the host of the project's own repository, or an explicit `host`.
The answer also names that repository (`projectRepository`), so rows in it open without naming
it and a pull request has one address however it was reached. Pages stop at 20.

Each notification becomes a typed row: repository, subject type, title, the number read from
the subject's API address (`…/pulls/229`, `…/issues/31`), reason, unread, updated and last-read
times, and the subject's GitHub address. The raw record is not sent to clients. Reasons and subject types are kept as GitHub sent
them, so a reason or type GitHub adds later still shows (clients put unknown ones in plain
words). A record missing the fields a row needs is skipped; the rest of the page still shows.
The subject's API address is only parsed, never requested.

Pull requests and issues also get their state (open, draft, merged, closed) from one GraphQL
read per changed page, aliased by repository and number. A refused or partial answer leaves
rows without a state; an inbox never fails because of it. States are kept with the page only
when read in full, so the next poll asks again rather than leaving rows stateless until the
notifications change.

### Polling and caching

Notifications go through the forge's bounded `GhApi` transport. It now keeps `Last-Modified`
and `X-Poll-Interval` with each cached page and sends `If-Modified-Since` (beside
`If-None-Match`) on the next read, so an unchanged inbox costs a 304, which GitHub doesn't
count against the rate limit. One `GitHubInbox` per host and signed-in account keeps its pages
between reads. Within GitHub's poll interval a repeat read of a page is answered from the last
answer without asking GitHub; concurrent reads of one page share one request (`ListCache`);
pages are decoded once (`PageDecoder`). Any write clears both, so the next read asks GitHub at
once. A rate limit is remembered until GitHub's reset: until then every read is answered with it
without starting `gh`.

The client polls the first page at GitHub's interval (`pollSeconds` in the answer) only while
the app is in front, never in the background. After a refusal that won't pass by itself
(`forge_notifications_unavailable`, `forge_forbidden`, `forge_unsupported`) it stops until the
person tries again; after a rate limit or a lost connection it waits five minutes. The sidebar's
Inbox row reads that same page for its quiet unread count, so the count costs nothing extra;
with a filter on, the page polls the filtered list as well. ace never notifies the operating
system about GitHub notifications.

### Writes

`forge.inbox.write` carries one of:

| Action        | Request                                                                               |
| ------------- | ------------------------------------------------------------------------------------- |
| `read`        | `PATCH /notifications/threads/{id}`                                                   |
| `done`        | `DELETE /notifications/threads/{id}`                                                  |
| `unsubscribe` | `DELETE /notifications/threads/{id}/subscription`                                     |
| `read-all`    | `PUT /notifications` or `PUT /repos/{owner}/{name}/notifications` with `last_read_at` |

GitHub's API has no way to mark a thread unread, so ace offers none. Every write passes the
identity-checked runner (the account is verified before dispatch) and the device's authority
is checked again just before the process starts. A write is never retried automatically. Its
receipt (`inboxAction`) is `succeeded`, `failed` (refused, or never sent) or `uncertain` (sent,
answer lost). Like every workspace command, an inbox write reserves its receipt before it runs,
so a command the client sends again after a lost answer is answered from that receipt and never
reaches GitHub twice. Unlike issue writes, inbox writes set a state rather than add one, so there
is no reconciliation: the person may send an uncertain write again, and the next read shows what
GitHub holds.

The page's Unsubscribe also marks the thread done, as GitHub's own inbox does. Mark all read
uses `read-all` everywhere or in the chosen repository, with `last_read_at` read from the clock
at the click; rows updated after it stay unread, as they do on GitHub. GitHub applies `read-all`
in the background (202), so the client keeps its own result and lets the next poll catch up
instead of reading at once. With the participating or reason filter on, GitHub has no matching
bulk call, so the rows on show are marked one by one. A refused write puts the rows back by
reading again.

### Error categories

A 403 to the account's notifications (`/notifications…`) becomes
`forge_notifications_unavailable`: gh's token can't reach them (a fine-grained or app token, or a
classic token without `notifications` or `repo`). A 401, gh's "not signed in" exit, and a 403
for one repository's notifications stay `forge_forbidden`, whose fix is signing in or access to
that repository. Clients say so in one sentence and name the fix
(`gh auth refresh -s notifications`). Rate limits, offline and other failures keep the forge's
existing categories.

### Web

The Inbox is a third tab beside Pull requests and Issues on the same full-page list frame,
with an Inbox row above Pull requests at the sidebar's foot. The sidebar remains the thread
list. Rows show the unread dot, the subject's state or type mark, number, title, repository,
reason in words and age. Filters: Unread / All, Everything / Participating, reason and
repository, all kept in the address. Pull requests and issues open as ace's own pages (with
`repo` for repositories other than the project's) and are marked read; their Back says
"Inbox" and returns there. Other subjects open on GitHub.

## Out of scope

- Operating-system notifications, sounds or badges for GitHub notifications.
- Marking unread, saving or snoozing notifications: GitHub's REST API offers none of these.
- Thread subscriptions beyond unsubscribe (watching repositories, custom routing).
- Discussion, release, commit and check-suite pages inside ace; they open on GitHub.
- GitLab and other forges.
- Native clients: the protocol and the reason and type words (`@ace/ui-core`) are shared, but
  only the web app shows the inbox for now.

Primary references: [Notifications REST API](https://docs.github.com/en/rest/activity/notifications),
[conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate).
