import { ForgeMutationOutcome, MutationDispatch } from "./mutation.ts";
import { ReadBudget } from "./read-budget.ts";
import { z } from "zod";
import { HostedRepository, RepositoryListInput, RepositoryPublishInput } from "@ace/protocol";
import { GhApi } from "./http.ts";
import { ForgeError } from "./errors.ts";
import type { CommandRunner } from "./command.ts";

const remote = z
  .object({
    id: z.number().int().positive(),
    name: z.string().max(100),
    owner: z.object({ login: z.string().max(100) }).passthrough(),
    description: z.string().max(4096).nullable(),
    private: z.boolean(),
    archived: z.boolean(),
    fork: z.boolean(),
  })
  .passthrough();
function hosted(host: string, value: unknown): HostedRepository {
  const parsed = remote.safeParse(value);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const row = parsed.data;
  const path = `${row.owner.login}/${row.name}`;
  return HostedRepository.parse({
    raw: row,
    id: row.id,
    repository: { forge: "github", host, owner: row.owner.login, name: row.name },
    description: row.description ?? "",
    visibility: row.private ? "private" : "public",
    archived: row.archived,
    fork: row.fork,
    url: `https://${host}/${path}`,
    cloneUrl: `https://${host}/${path}.git`,
  });
}
export class GitHubRepositories {
  private api: GhApi;
  readonly host: string;
  readonly account: string;
  constructor(options: { host: string; account: string; runner: CommandRunner; now(): number }) {
    this.host = options.host;
    this.account = options.account;
    this.api = new GhApi(options);
  }
  async list(input: RepositoryListInput, signal: AbortSignal): Promise<HostedRepository[]> {
    const filters = RepositoryListInput.parse(input);
    if (filters.host !== this.host || filters.account !== this.account)
      throw new ForgeError("forbidden");
    const result: HostedRepository[] = [];
    const budget = new ReadBudget();
    const query = filters.query.trim().toLowerCase();
    for (let page = 1; page <= 20; page++) {
      const response = await this.api.request(
        `user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=${page}`,
        signal,
      );
      budget.add(response.bytes);
      const parsed = z.array(remote).max(100).safeParse(response.body);
      if (!parsed.success) throw new ForgeError("invalid_data");
      const rows = parsed.data;
      for (const row of rows) {
        const repository = hosted(this.host, row);
        if (filters.owner && row.owner.login.toLowerCase() !== filters.owner.toLowerCase())
          continue;
        if (filters.visibility !== "all" && filters.visibility !== repository.visibility) continue;
        if (filters.archived !== "all" && repository.archived !== (filters.archived === "yes"))
          continue;
        if (filters.fork !== "all" && repository.fork !== (filters.fork === "yes")) continue;
        if (
          query &&
          !`${row.owner.login}/${row.name} ${row.description ?? ""}`.toLowerCase().includes(query)
        )
          continue;
        result.push(repository);
      }
      if (rows.length < 100) return result;
    }
    throw new ForgeError("limit");
  }
  async find(owner: string, name: string, signal: AbortSignal): Promise<HostedRepository | null> {
    const input = RepositoryPublishInput.pick({ owner: true, name: true }).parse({ owner, name });
    try {
      return hosted(
        this.host,
        (await this.api.request(`repos/${input.owner}/${input.name}`, signal)).body,
      );
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "not_found") return null;
      throw error;
    }
  }
  /** Caller journals intent before admission and reconciles failures; no automatic retries. */
  async create(input: RepositoryPublishInput, signal: AbortSignal, dispatch?: MutationDispatch): Promise<HostedRepository> {
    const value = RepositoryPublishInput.parse(input);
    if (value.host !== this.host || value.account !== this.account)
      throw new ForgeError("forbidden");
    const path =
      value.owner.toLowerCase() === this.account.toLowerCase()
        ? "user/repos"
        : `orgs/${value.owner}/repos`;
    const response = await this.api.request(path, signal, {
      name: value.name,
      description: value.description,
      private: value.visibility === "private",
      auto_init: false,
    }, "POST", dispatch);
    let repository: HostedRepository;
    try {
      repository = hosted(this.host, response.body);
    } catch {
      throw new ForgeMutationOutcome({ dispatched: true });
    }
    if (response.identityChanged) throw new ForgeMutationOutcome(repository);
    return repository;
  }
}
