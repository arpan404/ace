import { describe, expect, it } from "vitest";
import type { ContentPart } from "@ace/protocol";
import { fillPlaces, markPlaces } from "./placement.ts";

const text = (value: string): ContentPart => ({ type: "text", text: value });
const image = (name: string): ContentPart => ({
  type: "image",
  mimeType: "image/png",
  url: `data:image/png;base64,${name}`,
});
const pdf = (path: string): ContentPart => ({ type: "file", path, mimeType: "application/pdf" });
const mentionText = text("Attachment from @src/a.ts");
const skill: ContentPart = {
  type: "mention",
  entryId: "skill-review",
  name: "review",
  kind: "skill",
  arguments: "",
};

/** The message's input and context as the daemon sends them, files first-to-last. */
function place(
  input: ContentPart[],
  context: ContentPart[],
  files: { part: number; name: string; at?: number | undefined }[],
  interleaved: boolean,
): ContentPart[] {
  const marked = markPlaces(
    input,
    files.map((file) => file.at),
  );
  return fillPlaces(marked.input, marked.places, context, files, interleaved);
}

describe("a file reaches an interleaving provider where the person put it", () => {
  const shot = image("shot");
  const cases: {
    name: string;
    input: ContentPart[];
    at: (number | undefined)[];
    expected: ContentPart[];
  }[] = [
    {
      name: "no offsets keep today's order: text, then every file",
      input: [text("look here")],
      at: [undefined],
      expected: [text("look here"), shot],
    },
    {
      name: "at the start",
      input: [text("look here")],
      at: [0],
      expected: [shot, text("look here")],
    },
    {
      name: "in the middle",
      input: [text("look here")],
      at: [5],
      expected: [text("look "), shot, text("here")],
    },
    {
      name: "at the end",
      input: [text("look here")],
      at: [9],
      expected: [text("look here"), shot],
    },
    {
      name: "past the end clamps to the end",
      input: [text("look here")],
      at: [400],
      expected: [text("look here"), shot],
    },
    {
      name: "inside a surrogate pair moves to the pair's start",
      input: [text("a😀b")],
      at: [2],
      expected: [text("a"), shot, text("😀b")],
    },
    {
      name: "across text parts, counted as one joined text",
      input: [text("one "), text("two three")],
      at: [8],
      expected: [text("one "), text("two "), shot, text("three")],
    },
  ];
  for (const entry of cases)
    it(entry.name, () => {
      expect(
        place(entry.input, [shot], [{ part: 0, name: "shot.png", at: entry.at[0] }], true),
      ).toEqual(entry.expected);
    });

  it("keeps attach order for files at the same offset and sorts the rest by offset", () => {
    const [a, b, c] = [image("a"), image("b"), pdf("/files/c.pdf")];
    expect(
      place(
        [text("first second")],
        [a, b, c],
        [
          { part: 0, name: "a.png", at: 6 },
          { part: 1, name: "b.png", at: 0 },
          { part: 2, name: "c.pdf", at: 6 },
        ],
        true,
      ),
    ).toEqual([b, text("first "), a, c, text("second")]);
  });

  it("leaves mentions and unpositioned files after the text as today", () => {
    const later = image("later");
    expect(
      place(
        [text("see this then that")],
        [mentionText, shot, later],
        [
          { part: 1, name: "shot.png", at: 4 },
          { part: 2, name: "later.png" },
        ],
        true,
      ),
    ).toEqual([text("see "), shot, text("this then that"), mentionText, later]);
  });

  it("puts a file that became text at its spot", () => {
    const notes = text('Attachment "notes.txt" (text/plain, 3 bytes)');
    expect(
      place([text("read and fix")], [notes], [{ part: 0, name: "notes.txt", at: 5 }], true),
    ).toEqual([text("read "), notes, text("and fix")]);
  });

  it("puts a file at a mention's edge before the mention, wherever the mention sits", () => {
    // "fix @review [img]" and "fix [img] @review" both give at = 4: the mention adds no text.
    expect(
      place([text("fix "), skill, text(" now")], [shot], [{ part: 0, name: "s.png", at: 4 }], true),
    ).toEqual([text("fix "), shot, skill, text(" now")]);
    expect(
      place([skill, text("fix it")], [shot], [{ part: 0, name: "s.png", at: 0 }], true),
    ).toEqual([shot, skill, text("fix it")]);
  });

  it("sends the files after the text when their spots would pass the part limit", () => {
    const input = Array.from({ length: 200 }, (_, index) => text(`p${index} `));
    const files = Array.from({ length: 30 }, (_, index) => ({
      part: index,
      name: `${index}.png`,
      at: 1,
    }));
    const context = files.map((file) => image(file.name));
    expect(place(input, context, files, true)).toEqual([...input, ...context]);
  });

  it("sends a message without text exactly as today", () => {
    expect(place([], [shot], [{ part: 0, name: "shot.png", at: 0 }], true)).toEqual([shot]);
  });
});

describe("a provider that joins text names a native file at its spot", () => {
  it("names the file inline without splitting the text, and sends it after", () => {
    const shot = image("shot");
    expect(
      place([text("look here")], [shot], [{ part: 0, name: "shot.png", at: 5 }], false),
    ).toEqual([text("look [Attached image 1: shot.png]here"), shot]);
  });

  it("numbers files as they follow the text", () => {
    const [a, b] = [image("a"), pdf("/files/b.pdf")];
    const c = image("c");
    expect(
      place(
        [text("x y")],
        [a, b, c],
        [
          { part: 0, name: "a.png" },
          { part: 1, name: "b.pdf", at: 0 },
          { part: 2, name: "c.png", at: 2 },
        ],
        false,
      ),
    ).toEqual([text("[Attached PDF 1: b.pdf]x [Attached image 2: c.png]y"), a, b, c]);
  });

  it("puts a file that became text into the text at its spot, on lines of its own", () => {
    const notes = text('Attachment "notes.txt"');
    const shot = image("shot");
    expect(
      place(
        [text("read and fix")],
        [notes, shot],
        [
          { part: 0, name: "notes.txt", at: 5 },
          { part: 1, name: "shot.png", at: 5 },
        ],
        false,
      ),
    ).toEqual([text('read \nAttachment "notes.txt"\n[Attached image 1: shot.png]and fix'), shot]);
  });

  it("keeps a file that became text off the person's words when mentions join text tightly", () => {
    // OpenCode joins a message with a catalog mention without separators.
    const inline = 'Attachment "notes.txt"\n<ace-attachment>\nhi\n</ace-attachment>';
    expect(
      place(
        [skill, text("read and fix")],
        [text(inline)],
        [{ part: 0, name: "notes.txt", at: 5 }],
        false,
      ),
    ).toEqual([skill, text(`read \n${inline}\nand fix`)]);
  });

  it("names a file at the end of the text", () => {
    const shot = image("shot");
    expect(
      place([text("done")], [mentionText, shot], [{ part: 1, name: "shot.png", at: 99 }], false),
    ).toEqual([text("done[Attached image 1: shot.png]"), mentionText, shot]);
  });
});

describe("a placed file survives what rewrites the text before delivery", () => {
  it("keeps its spot when text around it is replaced and appended to", () => {
    const shot = image("shot");
    const marked = markPlaces([text("ab")], [1]);
    // A mention translation may prefix, coalesce or extend text; non-text parts stay in order.
    const rewritten = marked.input.map((part) =>
      part.type === "text" ? text(`<${part.text}>`) : part,
    );
    expect(
      fillPlaces(
        [...rewritten, text("\n\n<browser_tab/>")],
        marked.places,
        [shot],
        [{ part: 0, name: "shot.png" }],
        true,
      ),
    ).toEqual([text("<a>"), shot, text("<b>"), text("\n\n<browser_tab/>")]);
  });

  it("falls back to today's order when its placeholder is gone", () => {
    const shot = image("shot");
    const marked = markPlaces([text("ab")], [1]);
    expect(
      fillPlaces([text("ab")], marked.places, [shot], [{ part: 0, name: "shot.png" }], true),
    ).toEqual([text("ab"), shot]);
  });
});
