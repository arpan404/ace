import { Buffer } from "node:buffer";
import type { CommandRequest, CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { splitHttp, throwForStatus, type Headers } from "./gitlab-records.ts";
import { ForgeMutationOutcome, MutationDispatch } from "./mutation.ts";
import type { ReadBudget } from "./read-budget.ts";

/** Statuses after which GitLab has certainly not applied a write. */
const refused = new Set([400, 401, 403, 404, 409, 422, 429]);

export type GitLabResponse = { headers: Headers; body: unknown };

/**
 * `glab api --include` requests: the status line, headers and JSON body glab prints. Reads are
 * `glab api <endpoint> -X GET --hostname <host> --include`; writes are exactly
 * `glab api <endpoint> -X <METHOD> --hostname <host> --include --input -` with a JSON object on
 * stdin (ADR 0117). Stdout, stderr and credentials never leave as errors.
 */
export class GitLabApi {
  readonly #runner: CommandRunner;
  readonly #host: string;
  constructor(runner: CommandRunner, host: string) {
    this.#runner = runner;
    this.#host = host;
  }
  async get(endpoint: string, signal: AbortSignal, budget: ReadBudget): Promise<GitLabResponse> {
    try {
      return await this.#run(
        { command: "glab", args: this.#args(endpoint, "GET"), signal, mode: "json" },
        budget,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ForgeError) throw error;
      throw new ForgeError("cli");
    }
  }
  /** One write. A write whose answer wasn't seen fails as uncertain, never as refused. */
  async write(
    endpoint: string,
    method: "POST" | "PUT",
    body: Record<string, unknown>,
    signal: AbortSignal,
    budget: ReadBudget,
    dispatch: MutationDispatch = new MutationDispatch(),
  ): Promise<GitLabResponse> {
    const args = [...this.#args(endpoint, method), "--input", "-"];
    const request = { command: "glab", args, input: JSON.stringify(body), dispatch, signal };
    try {
      return await this.#run({ ...request, mode: "json" }, budget, dispatch);
    } catch (error) {
      throw dispatch.failure(error instanceof ForgeError ? error : new ForgeError("cli"));
    }
  }
  #args(endpoint: string, method: string): string[] {
    return ["api", endpoint, "-X", method, "--hostname", this.#host, "--include"];
  }
  async #run(
    request: CommandRequest,
    budget: ReadBudget,
    dispatch?: MutationDispatch,
  ): Promise<GitLabResponse> {
    request.signal.throwIfAborted();
    const output = await this.#runner(request);
    if (output.identityChanged) throw new ForgeMutationOutcome({ dispatched: true });
    if (output.truncated) throw new ForgeError("limit");
    if (output.unreachable) throw new ForgeError("offline");
    // One budget spans every request a read makes, counted in UTF-8 bytes.
    budget.add(Buffer.byteLength(output.stdout, "utf8"));
    const { headers, body } = splitHttp(output.stdout);
    const code = Number(/^HTTP\/[\d.]+ (\d{3})/i.exec(output.stdout)?.[1]);
    if (!Number.isInteger(code)) throw new ForgeError("invalid_data");
    if (refused.has(code)) dispatch?.reject();
    if (code === 409) throw new ForgeError("conflict");
    throwForStatus(code, headers, output.code);
    try {
      return { headers, body: JSON.parse(body) };
    } catch {
      throw new ForgeError("invalid_data");
    }
  }
}
