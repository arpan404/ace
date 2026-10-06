import { longHistory } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * Opening an attachment: from its chip in the composer (the browser's own file) or in the
 * transcript (bytes through the thread's connection). Text shows its first 64 KB, a PDF goes to
 * the browser's viewer, audio and video get native controls, and anything else its details with
 * Download. jsdom has no object URLs, so they are stubbed at that boundary and remember the blob
 * each one stands for.
 */

const objectUrls = new Map<string, Blob>();
const original = {
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
  click: HTMLAnchorElement.prototype.click,
};
const downloads: { name: string; blob: Blob | undefined }[] = [];
beforeEach(() => {
  localStorage.clear();
  let next = 0;
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const url = `blob:test/${++next}`;
    if (blob instanceof Blob) objectUrls.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => void objectUrls.delete(url);
  // Saving a file is the browser's to do: note what a download link would have saved.
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.download) downloads.push({ name: this.download, blob: objectUrls.get(this.href) });
  };
});
afterEach(() => {
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
  HTMLAnchorElement.prototype.click = original.click;
  objectUrls.clear();
  downloads.length = 0;
});

async function openComposer() {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-router");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  return { app, feed, message };
}

async function attach(...files: File[]) {
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText("Files to attach"), files);
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  return { user, chips };
}

test("Enter on a text chip shows its contents; a long file says it is truncated", async () => {
  await openComposer();
  const log = `${"GET /health 200\n".repeat(6_400)}`;
  const { user, chips } = await attach(
    new File(["export const answer = 42;\n"], "answer.ts"),
    new File([log], "server.log", { type: "text/plain" }),
  );

  const code = within(chips).getByRole("button", { name: "Preview answer.ts" });
  code.focus();
  await user.keyboard("{Enter}");
  let dialog = await screen.findByRole("dialog", { name: "answer.ts" });
  expect((await within(dialog).findByLabelText("File contents")).textContent).toBe(
    "export const answer = 42;\n",
  );
  expect(within(dialog).queryByText(/Truncated/)).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(code);

  await user.click(within(chips).getByRole("button", { name: "Preview server.log" }));
  dialog = await screen.findByRole("dialog", { name: "server.log" });
  const contents = await within(dialog).findByLabelText("File contents");
  expect(contents.textContent).toBe(log.slice(0, 64 * 1024));
  expect(within(dialog).getByText("Truncated: showing the first 64 KB of 102 KB.")).toBeTruthy();
});

test("a sent PDF opens in the browser's viewer, its bytes read through the thread", async () => {
  const pdf = "%PDF-1.7\n1 0 obj << >> endobj\n%%EOF";
  const { feed, message } = await openComposer();
  const { user } = await attach(new File([pdf], "spec.pdf", { type: "application/pdf" }));
  await user.type(message, "Summarize it{Enter}");
  const sent = await within(feed).findByRole("button", { name: /^spec\.pdf, / });

  await user.click(sent);
  const dialog = await screen.findByRole("dialog", { name: "spec.pdf" });
  const frame = await within(dialog).findByTitle("spec.pdf");
  expect(frame.tagName).toBe("IFRAME");
  const blob = objectUrls.get(frame.getAttribute("src") ?? "");
  expect(blob?.type).toBe("application/pdf");
  expect(await blob?.text()).toBe(pdf);
});

test("a sent text file shows the contents the daemon holds", async () => {
  const { feed, message } = await openComposer();
  const { user } = await attach(new File(["SELECT 1;\n"], "query.sql"));
  await user.type(message, "Run it{Enter}");
  await user.click(await within(feed).findByRole("button", { name: /^query\.sql, / }));
  const dialog = await screen.findByRole("dialog", { name: "query.sql" });
  expect((await within(dialog).findByLabelText("File contents")).textContent).toBe("SELECT 1;\n");
});

test("audio and video play in the browser's own players", async () => {
  await openComposer();
  const memo = new File(["ID3 audio"], "memo.mp3", { type: "audio/mpeg" });
  const clip = new File(["video bytes"], "clip.mp4", { type: "video/mp4" });
  const { user, chips } = await attach(memo, clip);

  await user.click(within(chips).getByRole("button", { name: "Preview memo.mp3" }));
  let dialog = await screen.findByRole("dialog", { name: "memo.mp3" });
  const audio = await within(dialog).findByLabelText("memo.mp3");
  expect(audio.tagName).toBe("AUDIO");
  expect(audio.hasAttribute("controls")).toBe(true);
  expect(objectUrls.get(audio.getAttribute("src") ?? "")).toBe(memo);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await user.click(within(chips).getByRole("button", { name: "Preview clip.mp4" }));
  dialog = await screen.findByRole("dialog", { name: "clip.mp4" });
  const video = await within(dialog).findByLabelText("clip.mp4");
  expect(video.tagName).toBe("VIDEO");
  expect(video.hasAttribute("controls")).toBe(true);
  expect(objectUrls.get(video.getAttribute("src") ?? "")).toBe(clip);
});

test("a file with no preview shows its details, and Download saves it under its name", async () => {
  const { feed, message } = await openComposer();
  const zip = "PK\u0003\u0004 archive";
  const { user } = await attach(new File([zip], "logs.zip", { type: "application/zip" }));
  await user.type(message, "Unpack{Enter}");
  await user.click(await within(feed).findByRole("button", { name: /^logs\.zip, / }));

  const dialog = await screen.findByRole("dialog", { name: "logs.zip" });
  expect(within(dialog).getByText(/No preview for ZIP archive files/)).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Download" }));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(downloads[0]?.name).toBe("logs.zip");
  expect(await downloads[0]?.blob?.text()).toBe(zip);
});
