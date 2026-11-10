import { Buffer } from "node:buffer";
import { ForgeRepository } from "@ace/protocol/forge";
import type { CommandRunner, CommandRequest } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { splitHttp, throwForStatus, type Headers } from "./gitlab-records.ts";
import type { MutationDispatch } from "./mutation.ts";
import type { ReadBudget } from "./read-budget.ts";

/** Shared glab transport. The caller supplies an identity-checked runner. */
export class GitLabApi {
  readonly repository: ForgeRepository;
  readonly root: string;
  readonly #runner: CommandRunner;
  constructor(options: { repository: ForgeRepository; runner: CommandRunner }) {
    this.repository = ForgeRepository.parse(options.repository);
    if (this.repository.forge !== "gitlab") throw new ForgeError("unsupported");
    this.#runner = options.runner;
    this.root = `projects/${encodeURIComponent(`${this.repository.owner}/${this.repository.name}`)}`;
  }

  async #send(request: CommandRequest, budget: ReadBudget) {
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
    budget.add(Buffer.byteLength(result.stdout, "utf8"));
    const response = splitHttp(result.stdout);
    const code = Number(/^HTTP\/[\d.]+ (\d{3})/i.exec(result.stdout)?.[1]);
    if (!Number.isInteger(code)) throw new ForgeError("invalid_data");
    try {
      throwForStatus(code, response.headers, result.code);
    } catch (error) {
      // An explicit host refusal proves no write landed. A timeout or identity change proves nothing.
      if (
        request.input !== undefined &&
        !result.identityChanged &&
        code >= 400 &&
        code < 500 &&
        code !== 408
      ) {
        const kind =
          code === 409
            ? request.args[1]?.endsWith("/merge")
              ? "head_moved"
              : "conflict"
            : code === 422
              ? "unprocessable"
              : error instanceof ForgeError
                ? error.kind
                : "cli";
        const refused = new ForgeError(kind, undefined, false);
        if (
          request.dispatch &&
          "reject" in request.dispatch &&
          typeof request.dispatch.reject === "function"
        )
          request.dispatch.reject(refused);
        throw refused;
      }
      throw error;
    }
    return { ...response, ...(result.identityChanged ? { identityChanged: true as const } : {}) };
  }

  #args(endpoint: string, method: string): string[] {
    // Only relative API endpoints. Never accept a URL or a CLI flag as an endpoint.
    if (
      !/^[A-Za-z][A-Za-z0-9_/?=&%.,:+~-]*$/.test(endpoint) ||
      endpoint.includes("://") ||
      endpoint
        .split("?")[0]
        ?.split("/")
        .some((part) => part === "." || part === "..")
    )
      throw new ForgeError("unsupported", undefined, false);
    return ["api", endpoint, "-X", method, "--hostname", this.repository.host, "--include"];
  }

  async text(endpoint: string, signal: AbortSignal, budget: ReadBudget) {
    return this.#send(
      { command: "glab", args: this.#args(endpoint, "GET"), signal, mode: "json" },
      budget,
    );
  }

  async get(
    endpoint: string,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<{ headers: Headers; body: unknown }> {
    const response = await this.text(endpoint, signal, budget);
    try {
      return { ...response, body: JSON.parse(response.body) };
    } catch {
      throw new ForgeError("invalid_data");
    }
  }

  async write(
    endpoint: string,
    method: "POST" | "PUT" | "DELETE",
    body: Record<string, unknown>,
    signal: AbortSignal,
    budget: ReadBudget,
    dispatch?: MutationDispatch,
  ): Promise<{ headers: Headers; body: unknown; identityChanged?: true }> {
    const response = await this.#send(
      {
        command: "glab",
        args: [...this.#args(endpoint, method), "--input", "-"],
        input: JSON.stringify(body),
        signal,
        mode: "json",
        ...(dispatch ? { dispatch } : {}),
      },
      budget,
    );
    try {
      return { ...response, body: response.body.trim() ? JSON.parse(response.body) : null };
    } catch {
      throw new ForgeError("invalid_data");
    }
  }
}
