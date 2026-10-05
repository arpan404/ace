import { longMarkdownAnswer } from "@ace/fake-daemon";

/*
 * Markdown an agent writes, and the constructs that make streamed parsing hard: fences left
 * open across blank lines, lists that continue after a blank line, setext headings, tables
 * still growing, quotes with lazy lines, HTML blocks and reference definitions that arrive
 * after the references (top-level, nested, or named like object members), and inline HTML
 * that leaves an anchor open across paragraphs.
 */

const headings = `# Release notes

Setext heading
==============

Second level
---

Paragraph with **bold**, *em*, \`code\`, ~~gone~~ and a [link](https://ace.dev/docs "Docs") then a
soft break, an autolink https://ace.dev/x and <https://ace.dev/y>.
#hashtag continues the paragraph
and so does this line.

#
## Closed ATX ##

***
- - -
___
`;

const lists = `Paragraph right above a list:
- one
- two
  continued lazily
- three

1. first
2. second

   loose paragraph in the second item

3. third
10. tenth

Text
2. not a list, it cannot interrupt

- [x] done
- [ ] open
  - nested **bold**
    - deeper with \`code\`

- item with a fence:

  \`\`\`sh
  bun install

  bun run test
  \`\`\`

- last item

* other bullet starts a new list
+ and another

Para after the lists.
`;

const fences = `Before the fence.
\`\`\`ts
const a = 1;

// a blank line above stays inside the fence
function f() {
  return a < 2 && "x";
}
\`\`\`
After the fence.

~~~python
def f():
    return """
not a fence end
~~~ still inside? no: this closes
"""
~~~

\`\`\`\`md
\`\`\`
inner fence text
\`\`\`
\`\`\`\`

    indented code

    continues after a blank line
not code

\`\`\`json
{ "open": "until the end"`;

const tables = `| file | lines | note |
| :--- | ---: | :---: |
| replay.ts | +29 | **bold** |
| outbox.ts | -4 | \`code\` |
| a | b | c |
ends the table? no, a row
Paragraph line
| head | er |
| --- | --- |
| x | y |

| alone |
| --- |

After.
`;

const quotes = `> A quote
lazy continuation
> - list in quote
> - more
>
> second paragraph
>> nested

> separate quote after a blank line

<div>
html block

</div>

<!-- a comment

spanning blank lines -->

<details>
<summary>More</summary>

Inside details.

</details>
`;

const references = `See [the docs][docs], [Docs] and [missing][nope] early on.

Some text with [inline](https://ace.dev/inline).

- a list with [docs] in it

[docs]: https://ace.dev/docs
[DOCS]: https://ace.dev/ignored "first definition wins"
[other]:
  https://ace.dev/other
  'Title on its own line'

Use [other] after its definition, and [multi].

[multi]: https://ace.dev/multi
'A title on the next line
that runs over two lines'
Not part of the title.

[late]: https://ace.dev/late
Trailing [late] reference.
`;

const titles = `Intro paragraph without brackets.

[multi]: https://ace.dev/multi
'A title on the next line
that runs over two lines'
Not part of the title.
`;

const nestedDefinitions = `> [early]: https://ace.dev/early

Use [early] after a definition inside a quote.

See [the guide][ref] and [the list][listed] before their definitions.

Other text.

> [ref]: https://ace.dev/quoted

- an item

  [listed]: https://ace.dev/listed

[ref]: https://ace.dev/ignored-the-quote-came-first

Then [ref] and [listed] again.
`;

const prototypeLabels = `Labels named like object members: [constructor] and [__proto__] (marked lowers
labels, so these two are the inherited ones), and [toString], which has no definition.

A paragraph between, so the references above settle before their definitions arrive.

[constructor]: https://ace.dev/constructor

> [__proto__]: https://ace.dev/proto

After: [constructor] [__proto__].
`;

const inlineHtml = `before <a href="https://ace.dev">text

www.ace.dev stays text inside the open anchor

last

</a> after it www.ace.dev/x links again

<code>raw *a*

</code> and *b* <span>www.ace.dev/y</span>
`;

const crlf =
  "# Windows\r\n\r\nLine one\r\nline two\r\n\r\n- a\r\n- b\r\n\r\n```\r\ncode\r\n```\r\n";

const spacing = `

Leading blank lines, then trailing spaces
make a hard break.



Many blank lines above.
Tabs	inside text.
	tab-indented code
end`;

/** Agent-shaped markdown, small enough to stream a character at a time. */
export const markdownSamples: Record<string, string> = {
  headings,
  lists,
  fences,
  tables,
  quotes,
  references,
  titles,
  nestedDefinitions,
  prototypeLabels,
  inlineHtml,
  crlf,
  spacing,
};

/** A long answer: sections of prose, lists, fenced code and tables, about 12 KB. */
export const longAnswer = longMarkdownAnswer(12_000);
