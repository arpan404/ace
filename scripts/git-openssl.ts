import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { findExecutable } from "@ace/provider-kit/discovery";

/**
 * Windows test setup only: puts Git for Windows' `openssl.exe` (`<Git>\usr\bin`) on PATH when
 * none is there, so the shared TLS fixture can be signed as it is elsewhere.
 */
export async function addGitOpenssl(env: NodeJS.ProcessEnv): Promise<void> {
  if (await findExecutable("openssl", env, "win32")) return;
  const git = await findExecutable("git", env, "win32");
  if (!git) return;
  // `<Git>\cmd\git.exe` or `<Git>\bin\git.exe`.
  const bin = join(dirname(dirname(git)), "usr", "bin");
  if (!existsSync(join(bin, "openssl.exe"))) return;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  env[key] = `${env[key] ?? ""};${bin}`;
}
