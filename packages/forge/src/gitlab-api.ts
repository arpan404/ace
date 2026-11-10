import { Buffer } from "node:buffer";
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { splitHttp, throwForStatus } from "./gitlab-records.ts";
import { ReadBudget } from "./read-budget.ts";
import { ForgeMutationOutcome, MutationDispatch } from "./mutation.ts";

/** glab's included HTTP envelope, shared by issue reads and writes. */
export class GitLabApi {
  readonly #runner: CommandRunner;
  readonly #host: string;
  constructor(runner: CommandRunner, host: string) {
    this.#runner = runner;
    this.#host = host;
  }
  async request(endpoint: string, signal: AbortSignal, budget: ReadBudget,
    body?: Record<string, unknown>, method = "GET", dispatch = new MutationDispatch()) {
    signal.throwIfAborted();
    try {
      const output = await this.#runner({ command: "glab",
        args: ["api", endpoint, "-X", method, "--hostname", this.#host, "--include",
          ...(body === undefined ? [] : ["--input", "-"])],
        ...(body === undefined ? {} : { input: JSON.stringify(body), dispatch }),
        signal, mode: "json" });
      if (output.identityChanged) throw new ForgeMutationOutcome({ dispatched: true });
      if (output.truncated) throw new ForgeError("limit");
      if (output.unreachable) throw new ForgeError("offline");
      budget.add(Buffer.byteLength(output.stdout, "utf8"));
      const { headers, body: text } = splitHttp(output.stdout);
      const code = Number(/^HTTP\/[\d.]+ (\d{3})/i.exec(output.stdout)?.[1]);
      if (!Number.isInteger(code)) throw new ForgeError("invalid_data");
      if ([400, 401, 403, 404, 409, 422, 429].includes(code)) dispatch.reject();
      if (code === 409) throw new ForgeError("conflict");
      throwForStatus(code, headers, output.code);
      try { return { headers, body: JSON.parse(text) as unknown }; }
      catch { throw new ForgeError("invalid_data"); }
    } catch (error) {
      if (body !== undefined) throw dispatch.failure(error);
      signal.throwIfAborted();
      if (error instanceof ForgeError) throw error;
      throw new ForgeError("cli");
    }
  }
}
