import { spawn } from "node:child_process";
import { z } from "zod";

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
  return {
    get(endpoint, etag, signal) {
      if (
        !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_/?=&.-]+$/.test(endpoint) ||
        endpoint.length > 1024
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
        const child = spawn(options.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        let bytes = 0;
        let problem: Error | undefined;
        const fail = (error: Error) => {
          problem ??= error;
          child.kill("SIGKILL");
        };
        const abort = () => fail(new Error("gh request aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => fail(new Error("gh request timed out")), timeoutMs);
        const collect = (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) fail(new Error("gh response exceeds byte limit"));
          else chunks.push(chunk);
        };
        child.stdout.on("data", collect);
        // Drain stderr without retaining credentials or unbounded diagnostic output.
        child.stderr.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) fail(new Error("gh response exceeds byte limit"));
        });
        child.on("error", (error) => {
          problem ??= error;
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (problem) {
            reject(problem);
            return;
          }
          try {
            const output = Buffer.concat(chunks).toString("utf8");
            const boundary = /\r?\n\r?\n/.exec(output);
            if (!boundary || boundary.index === undefined)
              throw new Error("Missing gh response headers");
            const header = output.slice(0, boundary.index),
              body = output.slice(boundary.index + boundary[0].length);
            const status = Number(/^HTTP\/\S+ (\d{3})/m.exec(header)?.[1]);
            if (status !== 304 && (code !== 0 || status !== 200))
              throw new Error(`gh GET failed with status ${status}`);
            const responseEtag = /^etag:\s*(.+)$/im.exec(header)?.[1]?.trim();
            const link = /^link:\s*(.+)$/im.exec(header)?.[1];
            const url = link?.split(",").find((part) => /rel="next"/.test(part));
            const nextUrl = url ? /<([^>]+)>/.exec(url)?.[1] : undefined;
            let next: string | undefined;
            if (nextUrl) {
              const parsed = new URL(nextUrl);
              if (parsed.origin !== "https://api.github.com")
                throw new Error("Untrusted pagination URL");
              next = parsed.pathname.slice(1) + parsed.search;
            }
            resolve({
              status,
              etag: responseEtag,
              next,
              data: status === 304 ? undefined : JSON.parse(body),
            });
          } catch (error) {
            reject(error);
          }
        });
      });
    },
  };
}
