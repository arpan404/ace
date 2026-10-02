import {
  spawnRawSupervised,
  type SpawnOptions,
  type RawSupervisedProcess,
} from "@ace/provider-kit/process";
import { z } from "zod";
import { parseGhResponse } from "./gh-response.ts";

export interface GhResponse {
  status: number;
  etag: string | undefined;
  next: string | undefined;
  data: unknown;
}
export interface GhClient {
  get(endpoint: string, etag?: string, signal?: AbortSignal): Promise<GhResponse>;
}
export interface GhOptions {
  binary: string;
  timeoutMs?: number;
  maxBytes?: number;
  spawn?: (options: SpawnOptions) => RawSupervisedProcess;
}
export function createGhClient(options: GhOptions): GhClient {
  const maxBytes = z
    .number()
    .int()
    .min(1024)
    .max(8_388_608)
    .parse(options.maxBytes ?? 2_097_152);
  const timeoutMs = z
    .number()
    .int()
    .min(1)
    .max(120_000)
    .parse(options.timeoutMs ?? 30_000);
  const spawn = options.spawn ?? spawnRawSupervised;
  return {
    get(endpoint, etag, signal) {
      const canonical = new URL(endpoint, "https://api.github.com/");
      if (
        !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_/?=&.-]+$/.test(endpoint) ||
        endpoint.length > 1024 ||
        canonical.origin !== "https://api.github.com" ||
        canonical.pathname.slice(1) + canonical.search !== endpoint
      )
        throw new Error("Invalid GitHub endpoint");
      if (etag !== undefined && (etag.length > 512 || /[\r\n]/.test(etag)))
        throw new Error("Invalid ETag");
      const args = [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--include",
        endpoint,
        "-H",
        "Accept: application/vnd.github+json",
      ];
      if (etag) args.push("-H", `If-None-Match: ${etag}`);
      return new Promise<GhResponse>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("gh request aborted"));
          return;
        }
        const child = spawn({ command: options.binary, args, env: {}, name: "automation-gh" });
        child.stdin.end();
        const chunks: Buffer[] = [];
        let bytes = 0;
        let finished = false;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        const fail = (error: Error) => {
          if (finished) return;
          finished = true;
          cleanup();
          // Reject independently of process exit: descendants may retain inherited pipes.
          reject(error);
          try {
            void child.stop({ graceMs: 0 }).catch(() => {});
          } catch {
            // The request has rejected even if the injected supervisor cannot stop.
          } finally {
            child.stdout.destroy();
            child.stderr.destroy();
            child.stdin.destroy();
          }
        };
        const abort = () => fail(new Error("gh request aborted"));
        const timer = setTimeout(() => fail(new Error("gh request timed out")), timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        const account = (chunk: Buffer): boolean => {
          if (finished) return false;
          bytes += chunk.length;
          if (bytes > maxBytes) {
            fail(new Error("gh response exceeds byte limit"));
            return false;
          }
          return true;
        };
        child.stdout.on("data", (chunk: Buffer) => {
          if (account(chunk)) chunks.push(chunk);
        });
        child.stderr.on("data", account);
        child.stdout.on("error", fail);
        child.stderr.on("error", fail);
        void child.exited.then(
          (exit) => {
            if (finished) return;
            finished = true;
            cleanup();
            try {
              if (exit.reason === "spawn-error") throw new Error("gh failed to start");
              resolve(parseGhResponse(chunks, exit.code));
            } catch (error) {
              reject(error);
            }
          },
          (error: unknown) => fail(error instanceof Error ? error : new Error("gh process failed")),
        );
      });
    },
  };
}
