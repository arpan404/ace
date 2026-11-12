# 0134: Spade reads documents, makes images and takes voice

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: build documents, images
and voice for Spade end to end, server and app). Builds on [ADR 0119](0119-spade-endpoint-keys.md),
[ADR 0126](0126-spade-agents.md), [ADR 0127](0127-spade-main-bot-and-chat.md),
[ADR 0128](0128-spade-memory.md) and [ADR 0130](0130-spade-skills-and-workspace.md).

## Context

A bot today takes words and images (PNG, JPEG, GIF, WebP, stored once by hash) and answers in
words. People hand assistants their files: a contract as a PDF, a report in Word, a spreadsheet,
a log, some code. They ask for a picture, a chart or a diagram, and they talk instead of typing.
`spade/docs/design.md` lists voice, files and image generation for the main bot and leaves
`web_fetch` reading PDFs for later.

Files are the riskiest input Spade takes. A PDF or an Office file is a small program for its
parser: a ZIP whose entries expand a thousandfold, a PDF stream that inflates to gigabytes,
nesting deep enough to overflow a stack, or a page that loops a parser. And a document's text is
written by whoever wrote the document, not the person, so it can carry instructions planted for
the bot, as a web page can.

## Options considered

- **Send every file to the model as it is.** Works only where an endpoint reads that type
  natively (few read Office files), costs page images for every PDF page, and leaves `web_fetch`
  and models without file input with nothing.
- **Extract text in the server process.** Simplest, but a parser bug (a stack overflow, an
  endless loop) takes the whole service down with it, and Rust cannot stop a thread.
- **An outside converter (a command-line tool or a service).** One more thing to install on every
  machine, or a file sent off the machine; neither fits ADR 0123.
- **Chosen:** pure-Rust parsers run in a short-lived child process with fixed limits, the text
  stored beside the file, and the file itself sent only to a model that reads it natively and
  only when that reads better per token.

## Decision

1. **Documents a message can carry.** PDF, Word (DOCX), Excel (XLSX), CSV and TSV, and any UTF-8
   text: Markdown, plain text, code, JSON, logs. At most 8 files a message, 32 MB each. The type is
   read from the bytes (a PDF header, a ZIP holding `word/document.xml` or `xl/workbook.xml`, valid
   UTF-8), never from the name alone; anything else is refused with one line saying which types
   are read. Legacy binary Office files (`.doc`, `.xls`), slides and images inside documents are
   not read.

2. **Stored once, by hash.** The bytes go to `<data>/documents/<sha256>` and the extracted text to
   `<sha256>.<reader>.txt` beside them (the reader is the kind and its version, so the same bytes
   read another way are another text), written aside and renamed like images. The message's event holds a
   reference: hash, name, media type, size, page count (PDF) or sheet count (XLSX), character
   count, whether the text was cut, and a trimmed view: the first 6,000 characters. The view is
   fixed when the message is stored, so a rebuilt prompt is the same bytes and the provider's
   cache stays warm. The file is also saved into the bot's workspace as `attachments/<name>`
   (`report (2).pdf` when the name is taken by other bytes), where the bot's shell and file tools
   reach it; it is never trusted there (ADR 0130), since Spade did not write it.

3. **The model sees a trimmed view and a handle.** In the prompt a document is
   `<document name="…" id="…" pages="…" chars="…">` around its view, then how much more there is
   and how to read it: `document_read` with the id and an offset returns the next window (20,000
   characters at most), the way large tool output is read. `document_read` is a read-only tool
   whose output is untrusted.

4. **Extraction runs in a child process, with limits.** The server re-runs its own binary as
   `spade-server extract-document`, hands it the bytes on stdin and reads one JSON answer from
   stdout, at most 20 MB. The child is killed after 20 seconds, and at most two run at once. Inside
   it, before any parser sees the file: a ZIP may hold at most 10,000 entries, and every entry the
   reader will open is first inflated through a counter that refuses the file past 64 MB from one
   entry, 256 MB in all, or an expansion of more than 200 times its compressed size; no PDF
   stream reaches the parser's inflater before Spade has inflated it under the same caps along its
   parsed filter chain, in lopdf's own load hook and before any page is read (image data is
   dropped unread). The child runs under a 1 GiB capped allocator. A PDF may have at most
   2,000 pages, a spreadsheet at most 1,000,000 cells. The text kept is at most 4 million
   characters or 8 MB; past that it is cut and marked as cut. Crates: `pdf-extract` on `lopdf` for PDF,
   `zip` and `quick-xml` with Spade's own readers for DOCX and XLSX (paragraphs, tables, tabs and
   line breaks; cells as tab-separated rows under each sheet's name), `csv` for CSV and TSV. All are
   MIT or MIT/Unlicense, pure Rust, and none touches the network. Tests run the same extraction in
   process.

5. **Documents are untrusted.** A message that carries a document makes its turn untrusted, as a
   fetched page does: writes ask first even when always allowed, and notes are only suggested
   (ADR 0128). So does every `document_read` result. The person attached the file, but its words
   are the author's.

6. **Native PDF input when it reads better per token.** A model whose facts say `pdf-input` gets
   the PDF itself (genai sends it as each format's document or file part) instead of the
   extracted text when the text layer is thin, fewer than 200 characters a page on average (a
   scan), and the file has at most 100 pages. Otherwise it gets the extracted text: reading a PDF
   natively costs its text plus an image of every page, so text is cheaper whenever there is
   text to read.

7. **`web_fetch` reads PDFs.** A response that is `application/pdf` (or starts with `%PDF-`) is
   read up to 20 MB and extracted the same way, in the same child, then paged in windows like any
   page. Its output stays untrusted.

8. **A bot can make images.** `image_generate` (a prompt, and optionally a size) is offered,
   deferred behind `tool_search`, only while the person's endpoints have a model whose facts say
   `image-generation` (the OpenAI-format `POST /images/generations` route, answered in base64)
   or `image-output` (a chat model that returns images in its reply, asked for with
   `modalities: ["image", "text"]`). It uses the bot's own model when that model can, else the
   first capable model on the person's endpoints. Its risk is `write`, since every image is
   billed: it asks first unless the person always allows it. The image is stored by hash in the
   image store and shown in the bot's bubble with Save; the model gets one line saying it was
   shown, not the image, so prompts stay small. It runs as a background job, so the tool deadline never
   cuts off an image already paid for; image and transcription calls are recorded in the spending
   ledger (tokens at token prices, plus a `per_call` price) and refused past the cap.

9. **A bot can show a file from its workspace.** `share_file` takes a workspace path. An image
   (PNG, JPEG, GIF, WebP, at most 3.75 MB) is stored by hash and shown in the bubble; any other
   file up to 32 MB is stored as a document and shown as a chip with Download. This is
   how charts and diagrams the bot drew with its shell reach the chat. Its risk is `read`.

10. **Voice in.** In the composer, the mic records while held and stops on release. The app
    transcribes on the device where the platform offers it (the Web Speech API in browsers that
    have it), else through `POST /v1/transcriptions`, which sends the audio to the model the
    person picked in Settings (`transcription_model`, an `endpoint/model`; a setting of its own that
    never changes the model's facts) on the OpenAI-format `POST /audio/transcriptions` route of its endpoint, with
    that endpoint's key from the keychain. With neither, the mic is not shown. The transcript
    lands in the composer to be checked; sending stores the audio (at most 25 MB: WebM, Ogg,
    MP4/M4A, MP3 or WAV) by hash in `<data>/audio/` and the transcript as the message's text. The
    bot receives the transcript, marked as spoken.

11. **Voice out.** "Read aloud" in a bubble's menu reads the reply with the system's own speech
    (`speechSynthesis`), on the device; nothing is sent anywhere.

12. **In the app.** The composer's attach takes images and documents; a document shows as a chip
    (name, pages or size) with Download in both the person's and the bot's bubbles; the
    images a bot makes or shares sit in its bubble with Save; tool calls stay out of the chat. The
    mic is the platform's own control glyph; every other control is a text button.

## Consequences

- Hostile files cost at most one child process for 20 seconds and the caps above; the service
  never runs a parser itself. The child runs under a capped allocator on every platform, with
  `setrlimit` on Unix as well.
- A conversation with a document stays untrusted until compaction leaves the document out, like
  one that read a page. Bots that are handed files often will ask before writes more often.
- Each document costs its bytes and text on disk once, however many messages or bots carry it.
- Model facts gain four capabilities: `pdf-input`, `image-generation`, `image-output` and
  `transcription`. Presets name them where providers document them; the person can set them on
  any saved model.
- Out of scope for now: OCR of scanned PDFs on models without PDF input, legacy Office formats,
  slides, images inside documents, voice replies from an endpoint and spoken conversation.

`spade/docs/media.md` describes the API and the limits.
