import { z } from "zod";
import { ProjectCommands } from "./projects.ts";

/*
 * What clients validate a project command with before sending it or keeping it in an outbox.
 * The core stream does not need it (its command union lists each project command already), so
 * a client loads it with its first project call (ADR 0056).
 */

/** Shared validation, also used before client outbox persistence. Test transports inject at Git's boundary. */
export const ProjectCloneUrl = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^(?:(?:https:\/\/|ssh:\/\/|git@)[^\s]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/)
  .refine((value) => {
    if ([...value].some((char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) === 127))
      return false;
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
      return value
        .split("/")
        .every((part) => part !== "." && part !== ".." && !part.startsWith("-"));
    if (value.startsWith("git@")) return /^git@[^/:]+:[^:?#]+$/.test(value);
    try {
      const url = new URL(value);
      return (
        Boolean(url.hostname) &&
        Boolean(url.pathname && url.pathname !== "/") &&
        !url.search &&
        !url.hash &&
        !url.password &&
        (url.protocol === "ssh:" || (url.protocol === "https:" && !url.username))
      );
    } catch {
      return false;
    }
  })
  .meta({
    "x-ace-constraint":
      "GitHub owner/repo shorthand, HTTPS, SSH or scp-style git@ URL with a host and repository path; no passwords, HTTPS usernames, whitespace or control bytes.",
    examples: [
      "https://example.invalid/repo.git",
      "ssh://git@example.invalid/repo.git",
      "git@example.invalid:repo.git",
    ],
  });
export const ProjectCommand = z.discriminatedUnion("type", ProjectCommands);
export type ProjectCommand = z.infer<typeof ProjectCommand>;
