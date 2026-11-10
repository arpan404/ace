import { Buffer } from "node:buffer";
import { ForgeRepository } from "@ace/protocol/forge";
import type { z } from "zod";
import type { CommandRequest, CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { splitHttp, throwForStatus, type Headers } from "./gitlab-records.ts";
import { ForgeMutationOutcome, MutationDispatch } from "./mutation.ts";
import type { ReadBudget } from "./read-budget.ts";

/** Statuses after which GitLab has certainly not applied a write. Anything else is uncertain. */
const refused = new Set([400, 401, 403, 404, 405, 409, 412, 422, 429]);

export type GitLabResponse = { headers: Headers; body: unknown };

/**
 * The one glab transport for every GitLab adapter (reader, reviews, checks, merge, inbox,
 * issues). Reads are `glab api <endpoint> -X GET --hostname <host> --include`; writes are exactly
 * `glab api <endpoint> -X <METHOD> --hostname <host> --include --input -` with a JSON object on
 * stdin (ADR 0117). The caller supplies an identity-checked runner. Stdout, stderr and
 * credentials never leave as errors.
 */
export class GitLabApi {
  readonly repository: ForgeRepository;
  /** `projects/<url-encoded path>`, the prefix of every project-scoped endpoint. */
  readonly root: string;
  readonly #runner: CommandRunner;
  constructor(options: { repository: ForgeRepository; runner: CommandRunner }) {
    this.repository = ForgeRepository.parse(options.repository);
    if (this.repository.forge !== "gitlab") throw new ForgeError("unsupported");
    this.#runner = options.runner;
    this.root = `projects/${encodeURIComponent(`${this.repository.owner}/${this.repository.name}`)}`;
  }

  /** The raw body of one GET, for non-JSON endpoints such as job traces. */
  text(endpoint: string, signal: AbortSignal, budget: ReadBudget) {
    return this.#send(
      { command: "glab", args: this.#args(endpoint, "GET"), signal, mode: "json" },
      budget,
    );
  }

  async get(endpoint: string, signal: AbortSignal, budget: ReadBudget): Promise<GitLabResponse> {
    const response = await this.text(endpoint, signal, budget);
    return { headers: response.headers, body: parse(response.body) };
  }

  /** Every row of an offset-paginated list, each checked against `schema`, up to 20 pages. */
  async records<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; page <= 20; page++) {
      const { body, headers } = await this.get(
        `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        signal,
        budget,
      );
      if (!Array.isArray(body) || body.length > 100) throw new ForgeError("invalid_data");
      for (const row of body) {
        const parsed = schema.safeParse(row);
        if (!parsed.success) throw new ForgeError("invalid_data");
        rows.push(parsed.data);
      }
      const next = headers["x-next-page"];
      if (next === "" || (next === undefined && body.length < 100)) return rows;
      if (next !== undefined && next !== String(page + 1)) throw new ForgeError("invalid_data");
    }
    throw new ForgeError("limit");
  }

  /**
   * One write. Only a status in `refused`, seen under an unchanged identity, fails definitely
   * (`dispatched: false`); any other failure after dispatch is uncertain. An identity change
   * after a successful reply is uncertain too, carrying `receipt(body)` for reconciliation.
   * An empty reply body is `null`.
   */
  async write(
    endpoint: string,
    method: "POST" | "PUT" | "DELETE",
    body: Record<string, unknown>,
    signal: AbortSignal,
    budget: ReadBudget,
    dispatch: MutationDispatch = new MutationDispatch(),
    receipt: (body: unknown) => unknown = () => ({ dispatched: true }),
  ): Promise<GitLabResponse> {
    try {
      const response = await this.#send(
        {
          command: "glab",
          args: [...this.#args(endpoint, method), "--input", "-"],
          input: JSON.stringify(body),
          signal,
          mode: "json",
          dispatch,
        },
        budget,
        dispatch,
      );
      const parsed = response.body.trim() ? parse(response.body) : null;
      if (response.identityChanged) throw new ForgeMutationOutcome(receipt(parsed));
      return { headers: response.headers, body: parsed };
    } catch (error) {
      throw dispatch.failure(error);
    }
  }

  #args(endpoint: string, method: string): string[] {
    // Only relative API endpoints. Never accept a URL or a CLI flag as an endpoint.
    if (
      !/^[A-Za-z][A-Za-z0-9_/?=&%.,:+~!'()*@-]*$/.test(endpoint) ||
      endpoint.includes("://") ||
      endpoint
        .split("?")[0]
        ?.split("/")
        .some((part) => part === "." || part === "..")
    )
      throw new ForgeError("unsupported", undefined, false);
    return ["api", endpoint, "-X", method, "--hostname", this.repository.host, "--include"];
  }

  async #send(request: CommandRequest, budget: ReadBudget, dispatch?: MutationDispatch) {
    request.signal.throwIfAborted();
    let result;
    try {
      result = await this.#runner(request);
    } catch (error) {
      request.signal.throwIfAborted();
      if (error instanceof ForgeError) throw error;
      throw new ForgeError("cli");
    }
    if (result.truncated) throw new ForgeError("limit");
    if (result.unreachable) throw new ForgeError("offline");
    // One budget spans every request a read makes, counted in UTF-8 bytes.
    budget.add(Buffer.byteLength(result.stdout, "utf8"));
    const response = splitHttp(result.stdout);
    const code = Number(/^HTTP\/[\d.]+ (\d{3})/i.exec(result.stdout)?.[1]);
    if (!Number.isInteger(code)) throw new ForgeError("invalid_data");
    try {
      if (code === 409) throw new ForgeError("conflict");
      if (code === 422) throw new ForgeError("unprocessable");
      throwForStatus(code, response.headers, result.code);
    } catch (error) {
      // An explicit refusal under the same identity proves no write landed.
      if (dispatch && !result.identityChanged && refused.has(code) && error instanceof ForgeError) {
        const kind =
          code === 409 && request.args[1]?.endsWith("/merge") ? "head_moved" : error.kind;
        const definite = new ForgeError(kind, error.retryAt, false);
        dispatch.reject(definite);
        throw definite;
      }
      throw error;
    }
    return { ...response, ...(result.identityChanged ? { identityChanged: true as const } : {}) };
  }
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ForgeError("invalid_data");
  }
}
