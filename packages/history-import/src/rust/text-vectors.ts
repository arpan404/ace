import { sanitizeTypedText, sanitizeUserText, timestamp } from "@ace/native-session";
import { summarizeOutput } from "@ace/projection";
import { sessionTitle } from "../user-text.ts";

/** Inputs the text rules are pinned on: real envelopes, edges of each rule and plain words. */
const samples = [
  "",
  "   plain words   ",
  "﻿ bom first",
  "/goal ship it",
  "/compact",
  "[ace-origin:thread-1]\nhello there",
  "<system-reminder>be careful</system-reminder>\nthe actual ask",
  "<system-reminder>unfinished",
  "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>the PR</command-args>",
  "<environment_context>\n  <cwd>/w</cwd>\n</environment_context>",
  "keep <b>bold</b> xml and <system-reminder>hidden</system-reminder> words",
  "<System-Reminder note=1>case</System-Reminder> after",
  "<user_instructions>a<user_instructions>b</user_instructions>c</user_instructions>tail",
  "<custom>mine</custom> stays",
  "# AGENTS.md instructions\nrules\n</INSTRUCTIONS>\nreal question",
  "# CLAUDE.md\nno end marker",
  "[Image #1] look at this",
  "[Attachment: a.png] see",
  "[Attached image saved at /tmp/x.png] check",
  "name: shot.png\nmimeType: image/png\nsizeBytes: 12\nwhat is this",
  "fileName: a.txt\nnot a field\nkeep",
  "  \n\nname: x.png\n  mimeType: image/png\nname: y\nkeep this",
  "TITLE REQUEST: shout",
  "a [user ATTACHED one or more images] b",
  "Attached file notes.txt\nsummarize",
  "<image>\ncaption",
  "The user interrupted the previous turn on purpose. Do x.",
  "A previous agent produced the plan below\n1. step",
  "Continue this conversation using the transcript context below\nstuff",
  "before [User attached one or more images] after",
  "trailing [User attached one or more images",
  "Title request: Check reconnect retries",
  "tabs\tand\nnewlines\r\n  here",
  "emoji 👋🏽 and accents é",
  "x".repeat(300),
  "👋".repeat(200),
  "Untitled",
  "new session - 2026",
  "<a href",
];

const outputs = [
  "",
  "short",
  "a".repeat(5000),
  "é".repeat(3000),
  "\u0001\u0002".repeat(1000),
  '"quoted"\\'.repeat(600),
  "﻿" + "b".repeat(10),
  "line\n".repeat(2000),
  "👋".repeat(1500),
];

const timestamps = [
  "2026-01-01T00:00:00Z",
  "2026-01-01T00:00:00.123Z",
  "2026-01-01T00:00:00.123456Z",
  "2026-01-01T10:20:30+05:30",
  "2026-01-01",
  "2026-02",
  "2026",
  "+002026-01-01T00:00:00Z",
  "2026-02-30T00:00:00Z",
  "2026-13-01",
  "2026-01-01T24:00:00Z",
  "2026-01-01T25:00:00Z",
  "1969-12-31T23:59:59Z",
  "not a date",
  "",
  1767225600000,
  1.5,
  -1,
];

/** Every shared text rule's outputs over the samples, for `native/history/vectors/text.json`. */
export function textVectors() {
  return {
    sanitize: samples.map((input) => ({
      input,
      user: sanitizeUserText(input),
      typed: sanitizeTypedText(input),
    })),
    title: samples.flatMap((preferred, index) => [
      {
        preferred,
        prompt: "",
        at: 1767225600000,
        output: sessionTitle(preferred, "", 1767225600000),
      },
      {
        preferred: "",
        prompt: preferred,
        at: index * 86_400_000,
        output: sessionTitle("", preferred, index * 86_400_000),
      },
    ]),
    output: outputs.map((text) => ({ text, output: summarizeOutput("item-1", text) })),
    timestamp: timestamps.map((input) => ({ input, output: timestamp(input) ?? null })),
  };
}
