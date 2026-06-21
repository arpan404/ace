import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem";

const decodeBrowseInput = Schema.decodeUnknownEffect(FilesystemBrowseInput);
const decodeBrowseResult = Schema.decodeUnknownEffect(FilesystemBrowseResult);

it.effect("parses filesystem browse input with optional cwd", () =>
  Effect.gen(function* () {
    const withCwd = yield* decodeBrowseInput({
      partialPath: " ~/code ",
      cwd: " /tmp/project ",
    });
    assert.deepEqual(withCwd, {
      partialPath: "~/code",
      cwd: "/tmp/project",
    });

    const withoutCwd = yield* decodeBrowseInput({
      partialPath: "/tmp",
    });
    assert.deepEqual(withoutCwd, {
      partialPath: "/tmp",
    });
  }),
);

it.effect("parses filesystem browse result entries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeBrowseResult({
      parentPath: "/tmp",
      entries: [
        {
          name: "repo",
          fullPath: "/tmp/repo",
        },
      ],
    });

    assert.equal(parsed.parentPath, "/tmp");
    assert.equal(parsed.entries[0]?.name, "repo");
    assert.equal(parsed.entries[0]?.fullPath, "/tmp/repo");
  }),
);
