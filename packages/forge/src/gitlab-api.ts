import { Buffer } from "node:buffer";
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { ForgeMutationOutcome } from "./mutation.ts";
import { ReadBudget } from "./read-budget.ts";
import { splitHttp, throwForStatus, type Headers } from "./gitlab-records.ts";
import type { WriteDispatch } from "./write-dispatch.ts";

/** Bounded GitLab REST I/O shared by MR reads and conversation writes. */
export class GitLabApi {
  readonly runner: CommandRunner;
  readonly host: string;
  constructor(runner: CommandRunner, host: string) {
    this.runner = runner;
    this.host = host;
  }
  get(endpoint: string, signal: AbortSignal, budget: ReadBudget) {
    return this.request(endpoint, signal, budget);
  }
  async request(
    endpoint: string,
    signal: AbortSignal,
    budget: ReadBudget,
    write?: { method: "POST" | "PUT"; body: Record<string, unknown>; dispatch: WriteDispatch },
  ): Promise<{ headers: Headers; body: unknown }> {
    signal.throwIfAborted();
    let result;
    try {
      result = await this.runner({
        command: "glab",
        args: [
          "api",
          endpoint,
          "-X",
          write?.method ?? "GET",
          "--hostname",
          this.host,
          "--include",
          ...(write ? ["--input", "-"] : []),
        ],
        ...(write ? { input: JSON.stringify(write.body), dispatch: write.dispatch } : {}),
        signal,
        mode: "json",
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ForgeError) throw error;
      throw new ForgeError("cli");
    }
    if (result.identityChanged) throw new ForgeMutationOutcome({ dispatched: true });
    if (result.truncated) throw new ForgeError("limit");
    if (result.unreachable) throw new ForgeError("offline");
    // One 8 MiB budget spans every request in the snapshot, counted in UTF-8 bytes.
    budget.add(Buffer.byteLength(result.stdout, "utf8"));
    const { headers, body } = splitHttp(result.stdout);
    const code = Number(/^HTTP\/[\d.]+ (\d{3})/i.exec(result.stdout)?.[1]);
    if (!Number.isInteger(code)) throw new ForgeError("invalid_data");
    try {
      throwForStatus(code, headers, result.code);
    } catch (error) {
      if (
        write &&
        [400, 401, 403, 404, 405, 409, 412, 422, 429].includes(code) &&
        error instanceof ForgeError
      ) {
        write.dispatch.reject();
        throw new ForgeError(
          code === 409 ? "conflict" : code === 422 ? "unprocessable" : error.kind,
          error.retryAt,
          false,
        );
      }
      throw error;
    }
    try {
      return { headers, body: JSON.parse(body) };
    } catch {
      throw new ForgeError("invalid_data");
    }
  }
  async records<T>(
    endpoint: string,
    schema: import("zod").z.ZodType<T>,
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
}
