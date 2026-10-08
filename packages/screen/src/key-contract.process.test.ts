import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { expect, it } from "vitest";
import { ScreenKey, ScreenNamedKey } from "@ace/protocol";

it.skipIf(process.platform !== "darwin")(
  "every advertised key and modifier is accepted by the native key resolver",
  async () => {
    const directory = new URL("../../../native/screen-helper/", import.meta.url).pathname;
    const [resolver, input] = await Promise.all([
      readFile(join(directory, "KeyInput.swift"), "utf8"),
      readFile(join(directory, "Input.swift"), "utf8"),
    ]);
    const start = input.indexOf("let usKeys:");
    const end = input.indexOf("}()", start);
    if (start < 0 || end < 0) throw new Error("Native key table cannot be read for the contract");
    const table = input.slice(start, end + 3);
    const aliases = resolver.slice(
      resolver.indexOf("let aliases:"),
      resolver.indexOf("]", resolver.indexOf("= [", resolver.indexOf("let aliases:"))) + 1,
    );
    const aliasNames = [...aliases.matchAll(/"([^"\\]+)"\s*:\s*\d+/g)].map((match) => match[1]);
    const root = await mkdtemp(join(tmpdir(), "ace-key-contract-"));
    const modifiers = ScreenNamedKey.shape.modifiers.unwrap().element.options;
    const source = `
import AppKit
struct HelperError: Error {
 let message: String; let code: String
 init(_ message: String, code: String = "internal") { self.message = message; self.code = code }
}
${table}
${resolver}
let keys: [String] = ${JSON.stringify(ScreenKey.options)}
let modifiers: [String] = ${JSON.stringify(modifiers)}
var accepted: [String] = []
for name in keys { _ = try namedKey(name, modifiers: []); accepted.append(name) }
var acceptedModifiers: [String] = []
for modifier in modifiers { _ = try namedKey("l", modifiers: [modifier]); acceptedModifiers.append(modifier) }
var rejected: [String] = []
for (key, flags) in [("cmd+l", [String]()), ("l", ["hyper"])] {
 do { _ = try namedKey(key, modifiers: flags) } catch let fault as HelperError { rejected.append(fault.code) }
}
let data = try JSONSerialization.data(withJSONObject: ["keys": accepted, "modifiers": acceptedModifiers, "rejected": rejected, "characters": usKeys.keys.map { String($0).lowercased() }.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }])
guard let text = String(data: data, encoding: .utf8) else { throw HelperError("Invalid fixture encoding") }
print(text)
`;
    try {
      const file = join(root, "main.swift"),
        executable = join(root, "contract");
      await writeFile(file, source);
      await promisify(execFile)("swiftc", [file, "-o", executable], { timeout: 60_000 });
      const result = await promisify(execFile)(executable, [], { timeout: 10_000 });
      const outcome = z
        .object({
          keys: z.array(z.string()),
          modifiers: z.array(z.string()),
          rejected: z.array(z.string()),
          characters: z.array(z.string()),
        })
        .parse(JSON.parse(result.stdout));
      expect(outcome.keys).toEqual(ScreenKey.options);
      expect(new Set(ScreenKey.options.map((key) => key.toLowerCase()))).toEqual(
        new Set([...aliasNames, ...outcome.characters]),
      );
      expect(outcome.modifiers).toEqual(modifiers);
      expect(outcome.rejected).toEqual(["key_unsupported", "modifier_unsupported"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
