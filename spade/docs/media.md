# Documents, images and voice

Date: 2026-11-12. As built for [ADR 0134](../../docs/adr/0134-spade-documents-images-voice.md), in
`spade-docs` (extraction), `spade-fetch` (PDF pages), `spade-models` (image and transcription
calls) and `spade-server` (`media/`, `api/media.rs`). Extends [chat-core.md](chat-core.md),
[harness.md](harness.md) and [workspace.md](workspace.md).

## Limits

| What                                 | Limit                                                      |
| ------------------------------------ | ---------------------------------------------------------- |
| Documents in one message             | 8 (images are counted apart, 8 too)                        |
| One document                         | 32 MB                                                      |
| A PDF `web_fetch` reads              | 20 MB                                                      |
| Pages in a PDF                       | 2,000                                                      |
| Cells in a spreadsheet               | 1,000,000                                                  |
| Entries in a ZIP (DOCX, XLSX)        | 10,000                                                     |
| One ZIP entry or PDF stream inflated | 64 MB, and at most 200 times its compressed size           |
| Everything inflated in one file      | 256 MB                                                     |
| Text kept from one document          | 4,000,000 characters or 8 MB (cut past that, and marked)   |
| Trimmed view in the prompt           | 6,000 characters                                           |
| One `document_read` window           | 20,000 characters                                          |
| Extraction time                      | 20 s, then the child is killed; two children at most       |
| Child's answer                       | 20 MB                                                      |
| Message body                         | 400 MB (`413` past it)                                     |
| Voice recording                      | 25 MB; WebM, Ogg, MP4/M4A, MP3 or WAV                      |
| A shared workspace image             | 3.75 MB (PNG, JPEG, GIF, WebP); other files 32 MB          |
| Native PDF input                     | at most 100 pages, and under 200 characters a page of text |

## Reading a document

The type comes from the bytes: `%PDF-` is a PDF; a ZIP with `word/document.xml` is DOCX and one
with `xl/workbook.xml` is XLSX; anything else must be valid UTF-8 and is text, with `.csv` and
`.tsv` names read as tables. A ZIP with neither part, a `.doc`/`.xls` file or other binary data is
refused with one line naming the types Spade reads.

`spade-docs` does the reading. `Extractor::child(program)` runs `program extract-document` (the
server's own binary), writes the bytes to its stdin and reads one JSON answer from stdout;
`Extractor::in_process()` runs the same code in the caller, for tests. Before any parser runs:

- **ZIP.** The central directory may list at most 10,000 entries. Every entry the reader opens is
  inflated through a counter first; one past 64 MB, past 200 times its compressed size, or a file
  past 256 MB in all is refused ("expands too far to read safely"). The reader then reads each
  entry through the same caps, so a header that lies about sizes gains nothing.
- **PDF.** Every `stream … endstream` is inflated the same way, filter by filter (Flate, LZW,
  ASCIIHex, ASCII85, run length), under the same caps, before `pdf-extract` sees the file. Then the
  page count must be at most 2,000.

DOCX text is the body's paragraphs in order, with tabs, line breaks and table cells (tab between
cells, a line per row), headers and footers left out. XLSX is each sheet under `## <sheet name>`,
one tab-separated line per row, shared and inline strings resolved, numbers as written, formulas
as their cached values. CSV and TSV become tab-separated lines. Text is kept to 4 million
characters and marked as cut past that.

### Storage

`<data>/documents/<sha256>` holds the bytes, `<sha256>.txt` the text, both written aside and renamed.
A copy goes to the bot's workspace as `attachments/<name>`; when that name holds other bytes the
copy is `attachments/<stem> (2).<ext>`, and so on. The copy is untrusted like any file Spade
did not write in a clean turn.

### In the prompt

```
<document name="report.pdf" id="d3f2…" pages="12" chars="48211">
…the first 6,000 characters…
</document>
[42,211 more characters; read on with document_read id="d3f2…" offset=6000]
```

`document_read { id, offset?, limit? }` (risk read, output untrusted) answers the window from
`offset` (default 0) of at most `limit` characters (default and most 20,000), with where the next
window starts when more remains. `id` is the document's SHA-256 (the first 12 hex characters are
enough when they name one document).

A message that carries a document makes its turn untrusted, as a fetched page does: the gate asks
before writes, and notes are only suggested. The source shows as "the attached file report.pdf".

A model whose facts include `pdf-input` gets the PDF itself, after the view's note, when the PDF
has at most 100 pages and fewer than 200 characters of text a page on average. Otherwise it gets
the text: native reading costs the text plus an image of every page.

## `web_fetch` and PDFs

A response typed `application/pdf`, or whose body starts with `%PDF-` under a generic type
(`application/octet-stream`), is read up to 20 MB and extracted by the same `Extractor`. The text
is paged like any page; the title is the file name from the address. Without an extractor
(`Fetcher::with_documents` not called) PDFs are refused as before.

## Images a bot makes or shares

`image_generate { prompt, size? }` (risk write, deferred) exists only while some saved model has
`image-generation` or `image-output`; it is found through `tool_search`. It uses the bot's own
model if that one can, else the first such model in the person's endpoint order.

- `image-generation`: `POST {base}/images/generations` with `{model, prompt, n: 1, size?}`; images
  come back as `data[].b64_json` (a `url` answer is refused: Spade never follows an address an
  endpoint hands back).
- `image-output`: `POST {base}/chat/completions` with `{model, messages: [{role: "user", content:
prompt}], modalities: ["image", "text"]}`; images come back as `choices[0].message.images[]`,
  each a `data:` URL.

Each image must be PNG, JPEG, GIF or WebP, at most 3.75 MB, and is put in the image store. The
model is told `Shown to the person: 1 image (sha256 …).` and does not see the image.

`share_file { path }` (risk read) shows a workspace file to the person: an image goes to the
image store, any other file to the document store (extracted like an attachment, so it opens as
text too).

Both record what they showed as a `shared` event, stored together with the call's
`tool_finished`; the model never reads it:

```json
{
  "type": "shared",
  "reply": "r1",
  "call_id": "c1",
  "images": [{ "sha256": "…", "media_type": "image/png", "bytes": 81234 }],
  "documents": []
}
```

The app shows them in the bubble of reply `reply`, after its text, and never shows the call.

## Voice

`POST /v1/transcriptions` `{ "data": "<base64 or data: URL>", "media_type": "audio/webm" }` sends
the audio as `multipart/form-data` (`model`, `file`) to `POST {base}/audio/transcriptions` of the
endpoint in the `transcription_model` setting, with its key, and answers `{ "text": "…" }`.
`409` when no transcription model is set, `400` for audio Spade does not take, `502` with one line
when the endpoint fails. The setting is `PUT /v1/settings { "transcription_model": "openai/whisper-1" }`
(`null` clears it) and is listed as `transcription_model` in `GET /v1/models`; the model must
exist on a saved endpoint.

A voice message is a message with `voice`: its audio is stored by hash in `<data>/audio/` and its
transcript is the message's text. The model reads `[Spoken; transcribed]` before the words.
`GET /v1/audio/{sha256}` answers the audio.

Reading replies aloud is the app's own (`speechSynthesis`); the server takes no part.

## API

`POST /v1/conversations/{id}/messages`, extended:

```json
{
  "text": "What does section 4 say?",
  "images": [{ "data": "…" }],
  "files": [{ "name": "contract.pdf", "data": "<base64>" }],
  "voice": {
    "data": "<base64>",
    "media_type": "audio/webm",
    "transcript": "What does section 4 say?"
  }
}
```

`202` once stored. `400` with one line when a file is refused ("contract.pdf expands too far to
read safely"), `413` past the body limit. Extraction happens before the answer, so a large file
takes a few seconds. A message may be only files, only images or only a voice note.

Events: `user_message` gains

```json
"documents": [{ "sha256": "…", "name": "contract.pdf", "media_type": "application/pdf",
                "bytes": 482113, "pages": 12, "chars": 48211, "cut": false, "view": "…" }],
"voice": { "sha256": "…", "media_type": "audio/webm", "bytes": 81234 }
```

`sheets` replaces `pages` for a spreadsheet; both are absent for text. A `shared` event (above)
carries what a tool showed the person.

| Route                                            | Answers                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `GET /v1/documents/{sha256}?name=`               | The bytes, its media type, `Content-Disposition: attachment` with `name` |
| `GET /v1/documents/{sha256}/text?offset=&limit=` | `{ text, total_chars, next_offset }` of the extracted text               |
| `GET /v1/audio/{sha256}`                         | The recording, with its media type                                       |
| `POST /v1/transcriptions`                        | `{ text }` (above)                                                       |

Model facts gain four capabilities, settable on any saved model like the others: `pdf-input`,
`image-generation`, `image-output`, `transcription`.

## Tests

`spade-docs`: text from PDF, DOCX, XLSX and CSV built in the test; a ZIP bomb, a lying ZIP header,
a PDF stream bomb, too many pages and too many cells are refused; text past the cap is cut and
marked; the child process answers like in-process extraction and a hung child is killed.
`spade-fetch`: a PDF page is read and paged; without an extractor it is refused.
`spade-server` (fake endpoints): an attachment is stored once however often it is sent, saved in
the workspace, shown as a view and read by window; a turn with a document is untrusted;
`image_generate` exists only with a capable model, stores by hash and records a `shared` event;
`share_file` shows a workspace chart; a transcript reaches the bot and the audio is stored.
Web: attaching a document sends it, chips and bot images render, the mic is hidden without a way
to transcribe, and Read aloud speaks the reply.
