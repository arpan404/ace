import { z } from "zod";

/**
 * A relative path that stays inside the folder it is read from, on every platform: `/` only, no
 * empty, `.` or `..` part, no device names, no `.git`, nothing a Windows path would read
 * differently. Plugin files and a skill's files are named with it.
 */
export const ContainedPath = z
  .string()
  .min(1)
  .max(512)
  .refine((input) => {
    const value = input.startsWith("./") ? input.slice(2) : input;
    return (
      !value.includes("\\") &&
      !/[<>:"|?*]/.test(value) &&
      ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
      !value.startsWith("/") &&
      value
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
            ![".git", "__proto__", "constructor", "prototype"].includes(part) &&
            !/[. ]$/.test(part),
        )
    );
  }, "Must be a contained relative path")
  .meta({
    "x-ace-constraint":
      "A relative path with / only: no empty, . or .. part, no device names, .git or characters Windows reads differently.",
  });
