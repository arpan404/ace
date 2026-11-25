import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });

beforeEach(() => {
  localStorage.clear();
  let made = 0;
  // jsdom has no object URLs.
  URL.createObjectURL = () => `blob:spade/${++made}`;
  URL.revokeObjectURL = () => {};
});

const hash = (char: string) => char.repeat(64);

const doc = (char: string, name: string, mediaType: string, bytes: number, pages?: number) => ({
  sha256: hash(char),
  name,
  media_type: mediaType,
  bytes,
  ...(pages === undefined ? {} : { pages }),
  chars: 100,
  cut: false,
  view: "…",
});

function withWriter(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return api.addAgent({ id: "writer", name: "Writer" });
}

test("a picture sits inline and opens in a lightbox that Escape closes", async () => {
  await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.images.set(hash("a"), "image/png");
    api.store(writer.conversation, {
      type: "user_message",
      text: "Look",
      images: [{ sha256: hash("a"), media_type: "image/png", bytes: 9 }],
    });
  });
  await userEvent.click(await botRow("Writer"));
  await userEvent.click(await screen.findByRole("button", { name: "Open image" }));
  const lightbox = await screen.findByRole("dialog");
  within(lightbox).getByRole("link", { name: "Download image" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("several pictures show as a grid whose last cell counts the rest", async () => {
  await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    const images = ["a", "b", "c", "d", "e", "f"].map((char) => {
      api.images.set(hash(char), "image/png");
      return { sha256: hash(char), media_type: "image/png", bytes: 9 };
    });
    api.store(writer.conversation, { type: "user_message", text: "Many", images });
  });
  await userEvent.click(await botRow("Writer"));
  const grid = within(await screen.findByRole("group", { name: "6 images" }));
  await grid.findByRole("button", { name: "Open image, and 2 more" });
  expect(grid.getAllByRole("button")).toHaveLength(4);
});

test("a document card names its type, pages and size, with the middle of a long name cut", async () => {
  await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.store(writer.conversation, {
      type: "user_message",
      text: "Read it",
      documents: [
        doc(
          "d",
          "lisbon-hotel-shortlist-cancellation-terms-2026.pdf",
          "application/pdf",
          2_400_000,
          6,
        ),
      ],
    });
  });
  await userEvent.click(await botRow("Writer"));
  const card = within(
    await screen.findByRole("group", {
      name: "lisbon-hotel-shortlist-cancellation-terms-2026.pdf",
    }),
  );
  card.getByText("PDF · 6 pages · 2.4 MB");
  // The name keeps its extension; its middle gives way.
  card.getByText(/2026\.pdf$/);
  expect(card.getByText(/^lisbon-hotel/).textContent).not.toContain("terms");
});

test("Open shows a document in the panel's reader, rendered, and back returns to the panel", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.media.documentBodies.set(hash("9"), {
      body: "# Day plan\n\n- Sintra by rail\n",
      contentType: "text/markdown",
      encoding: "text",
    });
    api.store(writer.conversation, {
      type: "user_message",
      text: "Here",
      documents: [doc("9", "plan.md", "text/markdown", 28)],
    });
  });
  await userEvent.click(await botRow("Writer"));
  const card = within(await screen.findByRole("group", { name: "plan.md" }));
  await userEvent.click(card.getByRole("button", { name: "Open" }));
  const reader = within(await screen.findByRole("region", { name: "plan.md" }));
  await reader.findByRole("heading", { name: "Day plan" });
  expect(spade.requests.map((request) => request.path)).toContain(
    `/v1/documents/${hash("9")}?name=plan.md`,
  );
  await userEvent.click(reader.getByRole("button", { name: /back/i }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "plan.md" })).toBeNull());
});

test("past three documents the list collapses behind a count", async () => {
  await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.store(writer.conversation, {
      type: "user_message",
      text: "Pack",
      documents: ["a", "b", "c", "d", "e"].map((char) =>
        doc(char, `file-${char}.pdf`, "application/pdf", 1000),
      ),
    });
  });
  await userEvent.click(await botRow("Writer"));
  await screen.findByRole("group", { name: "file-a.pdf" });
  expect(screen.queryByRole("group", { name: "file-d.pdf" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "2 more" }));
  await screen.findByRole("group", { name: "file-e.pdf" });
});

test("the narrow panel shows one level of Files at a time: the list, then one file alone", async () => {
  await spadeApp("/spade/writer?profile=library", (api) => {
    withWriter(api);
    api.files.set("writer", { "plan.md": "# Plan\n\n- Sintra by rail\n", "todo.txt": "milk" });
  });
  const library = await screen.findByRole("button", { name: /^plan\.md/ });
  await userEvent.click(library);
  // The file alone, rendered, with no file tree or list beside it.
  const reader = within(await screen.findByRole("region", { name: "plan.md" }));
  await reader.findByRole("heading", { name: "Plan" });
  expect(screen.queryByRole("list", { name: "Files" })).toBeNull();
  // "All files" in the header menu moves to the list, which then stands alone.
  await userEvent.click(reader.getByRole("button", { name: "File options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "All files" }));
  const files = within(await screen.findByRole("list", { name: "Files" }));
  files.getByRole("button", { name: /^todo\.txt/ });
  expect(screen.queryByRole("heading", { name: "Plan" })).toBeNull();
});

test("a reply always shows its ghost: a quoted file by name, a quoted attachment from elsewhere as Attachment", async () => {
  await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.store(writer.conversation, {
      type: "user_message",
      text: "",
      documents: [doc("a", "tap-confirmation.pdf", "application/pdf", 1000, 2)],
    });
    api.store(writer.conversation, {
      type: "user_message",
      text: "Does this include a bag?",
      reply_to: { id: "m1", text: "", mine: true },
    });
    api.store(writer.conversation, {
      type: "user_message",
      text: "And this one?",
      reply_to: { id: "m40", text: "", mine: false, name: "Inbox" },
    });
  });
  await userEvent.click(await botRow("Writer"));
  const ghosts = await screen.findAllByRole("button", { name: /Show the message$/ });
  // Never an empty ghost: each says what it quotes.
  expect(ghosts.map((ghost) => ghost.textContent)).toEqual(["tap-confirmation.pdf", "Attachment"]);
});

test("the PDF reader in the panel fills it with the file and its options name the page count", async () => {
  await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.store(writer.conversation, {
      type: "user_message",
      text: "",
      documents: [doc("7", "report.pdf", "application/pdf", 2_400_000, 6)],
    });
  });
  await userEvent.click(await botRow("Writer"));
  await userEvent.click(await screen.findByRole("button", { name: "Open report.pdf" }));
  const reader = within(await screen.findByRole("region", { name: "report.pdf" }));
  const frame = await reader.findByTitle("report.pdf");
  expect(frame.getAttribute("src")).toMatch(/^blob:/);
  await userEvent.click(reader.getByRole("button", { name: "File options" }));
  within(await screen.findByRole("menu")).getByText("PDF · 6 pages · 2.4 MB");
});

test("a caption sits in the same bubble as its files, under them", async () => {
  await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.store(writer.conversation, {
      type: "user_message",
      text: "Here is my confirmation",
      documents: [doc("8", "tap.pdf", "application/pdf", 1000, 2)],
    });
  });
  await userEvent.click(await botRow("Writer"));
  const card = await screen.findByRole("group", { name: "tap.pdf" });
  const bubble = card.closest('[data-part="spade-message"]');
  expect(bubble).not.toBeNull();
  const caption = within(bubble as HTMLElement).getByText("Here is my confirmation");
  // The files come first in the bubble, the caption after.
  expect(card.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a document without a preview wears its type's own colour and extension", async () => {
  await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.store(writer.conversation, {
      type: "user_message",
      text: "",
      documents: [
        doc("1", "a.zip", "application/zip", 10),
        doc(
          "2",
          "b.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          10,
        ),
      ],
    });
  });
  await userEvent.click(await botRow("Writer"));
  const zip = within(await screen.findByRole("group", { name: "a.zip" }));
  const docx = within(await screen.findByRole("group", { name: "b.docx" }));
  const tile = (card: typeof zip, mark: string) => card.getByText(mark, { selector: "span" });
  const zipTile = await waitFor(() => tile(zip, "ZIP"));
  const docxTile = await waitFor(() => tile(docx, "DOCX"));
  expect(zipTile.style.color).not.toBe("");
  expect(zipTile.style.color).not.toBe(docxTile.style.color);
});
