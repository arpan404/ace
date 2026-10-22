import { z } from "zod";
import {
  ForgeInboxQuery,
  ForgeInboxWrite,
  type ForgeInboxList,
  type ForgeInboxRow,
  type ForgeInboxSubjectState,
} from "@ace/protocol/forge-inbox";
import type { CommandRunner } from "./command.ts";
import { ForgeAccessRefused, ForgeError } from "./errors.ts";
import { GhApi, type Page } from "./http.ts";
import { GitHubNotification, inboxRow, pollSeconds, subjectState } from "./inbox-rows.ts";
import { ListCache } from "./list-cache.ts";
import { ForgeMutationOutcome } from "./mutation.ts";
import { PageDecoder } from "./resource.ts";
import type { WriteDispatch } from "./write-dispatch.ts";

const perPage = 50;
const maxRemembered = 32;
type Remembered = { page: Page; at: number; list: ForgeInboxList };

/**
 * A 403 to the account's notifications means gh's token can't reach them (a fine-grained or app
 * token, or a classic token without `notifications` or `repo`). A 401, gh's "not signed in" exit
 * and a refusal for one repository's notifications keep their own meaning.
 */
function notificationsError(error: unknown, path: string): unknown {
  return error instanceof ForgeAccessRefused &&
    error.status === 403 &&
    /^notifications(?:[/?]|$)/.test(path)
    ? new ForgeError("notifications_unavailable", undefined, error.dispatched)
    : error;
}

/**
 * The signed-in account's GitHub notifications on one host, read and changed through `gh`.
 * A page is asked for again only after GitHub's poll interval, and then conditionally, so an
 * unchanged inbox costs a 304 that GitHub doesn't count against the rate limit.
 */
export class GitHubInbox {
  readonly host: string;
  readonly #api: GhApi;
  readonly #now: () => number;
  /** Reads of one page while another is on its way share it. */
  readonly #flights: ListCache<ForgeInboxList>;
  readonly #recent = new Map<string, Remembered>();
  readonly #decoder = new PageDecoder(z.array(z.unknown()).max(100));
  readonly #states = new WeakMap<Page, Map<string, ForgeInboxSubjectState>>();
  /** GitHub's rate limit, until its reset: no read asks again before then. */
  #limited: ForgeError | undefined;
  constructor(options: {
    runner: CommandRunner;
    command?: string;
    host: string;
    now: () => number;
  }) {
    this.host = options.host;
    this.#now = options.now;
    this.#flights = new ListCache(options.now, 0);
    this.#api = new GhApi({
      ...options,
      // A write changes what every page shows: the next read asks GitHub at once. The rate
      // limit stays: it belongs to the account, not to a page.
      onWrite: () => {
        this.#recent.clear();
        this.#flights.invalidate();
      },
    });
  }
  list(input: ForgeInboxQuery, signal: AbortSignal): Promise<ForgeInboxList> {
    const query = ForgeInboxQuery.parse(input);
    if (query.repository && query.repository.host !== this.host)
      throw new ForgeError("unsupported");
    const params = new URLSearchParams({
      all: String(query.all),
      participating: String(query.participating),
      per_page: String(perPage),
      page: String(query.page),
      ...(query.since ? { since: query.since } : {}),
    });
    const root = query.repository
      ? `repos/${query.repository.owner}/${query.repository.name}/notifications`
      : "notifications";
    const path = `${root}?${params}`;
    return this.#flights.read(path, signal, (shared) => this.#read(path, query.page, shared));
  }
  async #read(path: string, number: number, signal: AbortSignal): Promise<ForgeInboxList> {
    const recent = this.#recent.get(path);
    const now = this.#now();
    if (recent && now - recent.at < recent.list.pollSeconds * 1_000)
      return { ...recent.list, unchanged: true };
    const limited = this.#limited;
    if (limited?.retryAt !== undefined && now < limited.retryAt) throw limited;
    let page: Page;
    try {
      page = await this.#api.request(path, signal);
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "rate_limit") this.#limited = error;
      throw notificationsError(error, path);
    }
    const rows = this.#decoder
      .read(page)
      .flatMap((value) => {
        const parsed = GitHubNotification.safeParse(value);
        return parsed.success ? [inboxRow(this.host, parsed.data)] : [];
      })
      .slice(0, perPage);
    // States are kept with the page only once read in full; a refused read is asked again.
    let states = this.#states.get(page);
    if (!states) {
      const read = await this.#readStates(rows, signal);
      states = read.states;
      if (read.complete) this.#states.set(page, states);
    }
    for (const row of rows) {
      const state = row.number
        ? states.get(stateKey(row.repository.owner, row.repository.name, row.number))
        : undefined;
      // The row is new here, so it takes its state in place.
      if (state && (row.type === "PullRequest" || row.type === "Issue")) row.state = state;
    }
    const list: ForgeInboxList = {
      host: this.host,
      items: rows,
      ...(this.#api.next(page, path) && number < 20 ? { nextPage: number + 1 } : {}),
      pollSeconds: pollSeconds(page.headers["x-poll-interval"]),
      unchanged: recent?.page === page,
    };
    this.#recent.delete(path);
    this.#recent.set(path, { page, at: this.#now(), list });
    if (this.#recent.size > maxRemembered) {
      const oldest = this.#recent.keys().next().value;
      if (oldest !== undefined) this.#recent.delete(oldest);
    }
    return list;
  }
  /**
   * Open, draft, merged or closed for every pull request and issue on the page, in one GraphQL
   * read. A page without them, or a read GitHub refuses, leaves rows without a state.
   */
  async #readStates(
    rows: readonly ForgeInboxRow[],
    signal: AbortSignal,
  ): Promise<{ states: Map<string, ForgeInboxSubjectState>; complete: boolean }> {
    const wanted = new Map<string, { owner: string; name: string; numbers: Set<number> }>();
    for (const row of rows) {
      if ((row.type !== "PullRequest" && row.type !== "Issue") || !row.number) continue;
      const key = `${row.repository.owner}/${row.repository.name}`.toLowerCase();
      const entry = wanted.get(key) ?? {
        owner: row.repository.owner,
        name: row.repository.name,
        numbers: new Set<number>(),
      };
      entry.numbers.add(row.number);
      wanted.set(key, entry);
    }
    const states = new Map<string, ForgeInboxSubjectState>();
    if (!wanted.size) return { states, complete: true };
    const repos = [...wanted.values()];
    const fields = repos.map(
      (repo, index) =>
        `r${index}: repository(owner:${JSON.stringify(repo.owner)},name:${JSON.stringify(repo.name)}) { ${[
          ...repo.numbers,
        ]
          .map(
            (number) =>
              `n${number}: issueOrPullRequest(number:${number}) { __typename ... on PullRequest { state isDraft } ... on Issue { state } }`,
          )
          .join(" ")} }`,
    );
    let body: unknown;
    try {
      body = (
        await this.#api.request("graphql", signal, {
          query: `query InboxStates { ${fields.join(" ")} }`,
        })
      ).body;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ForgeError && error.kind === "offline") throw error;
      return { states, complete: false };
    }
    const data = z
      .object({ data: z.record(z.string(), z.record(z.string(), z.unknown()).nullable()) })
      .safeParse(body);
    if (!data.success) return { states, complete: false };
    repos.forEach((repo, index) => {
      const nodes = data.data.data[`r${index}`];
      if (!nodes) return;
      for (const number of repo.numbers) {
        const state = subjectState(nodes[`n${number}`]);
        if (state) states.set(stateKey(repo.owner, repo.name, number), state);
      }
    });
    return { states, complete: true };
  }
  /**
   * Marks a thread read or done, unsubscribes from it, or marks everything read. Each sets a
   * state rather than adding one, so the person may send an uncertain write again; nothing
   * here retries it.
   */
  async write(input: ForgeInboxWrite, signal: AbortSignal, dispatch?: WriteDispatch) {
    const value = ForgeInboxWrite.parse(input);
    const thread = value.action === "read-all" ? "" : `notifications/threads/${value.id}`;
    const request: [string, unknown, string] =
      value.action === "read"
        ? [thread, undefined, "PATCH"]
        : value.action === "done"
          ? [thread, undefined, "DELETE"]
          : value.action === "unsubscribe"
            ? [`${thread}/subscription`, undefined, "DELETE"]
            : [
                value.repository
                  ? `repos/${value.repository.owner}/${value.repository.name}/notifications`
                  : "notifications",
                { last_read_at: value.before, read: true },
                "PUT",
              ];
    if (value.action === "read-all" && value.repository && value.repository.host !== this.host)
      throw new ForgeError("unsupported");
    let page: Page;
    try {
      page = await this.#api.request(request[0], signal, request[1], request[2], dispatch);
    } catch (error) {
      throw notificationsError(error, request[0]);
    }
    if (page.identityChanged) throw new ForgeMutationOutcome({ dispatched: true });
  }
}

function stateKey(owner: string, name: string, number: number): string {
  return `${owner}/${name}#${number}`.toLowerCase();
}
