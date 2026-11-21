import { expect, test } from "vitest";
import { drawnAsPicture, originalStandsIn } from "./attachment-picture.ts";

/*
 * Which of a message's files the phone draws as a picture: every image type iOS decodes, by its
 * type or, when the type is vague, its name. Agents may still see some of them as files.
 */

test.each([
  ["image/png", "screen.png"],
  ["image/jpeg", "photo.jpg"],
  ["image/gif", "loop.gif"],
  ["image/webp", "shot.webp"],
  ["image/heic", "Pasted image.heic"],
  ["image/heif", "IMG_0001.heif"],
  ["image/tiff", "scan.tiff"],
  ["image/bmp", "old.bmp"],
  ["application/octet-stream", "Pasted image.HEIC"],
  ["application/octet-stream", "IMG_0002.heif"],
])("%s named %s is drawn as a picture", (mimeType, name) => {
  expect(drawnAsPicture({ mimeType, name })).toBe(true);
});

test.each([
  ["image/svg+xml", "logo.svg"],
  ["application/pdf", "notes.pdf"],
  ["text/plain", "routes.txt"],
  ["application/octet-stream", "data.bin"],
])("%s named %s stays a file", (mimeType, name) => {
  expect(drawnAsPicture({ mimeType, name })).toBe(false);
});

test("a HEIC with no preview is drawn from its original only while that is small", () => {
  const heic = { mimeType: "image/heic", name: "Pasted image.heic" };
  expect(originalStandsIn({ ...heic, bytes: 215_000 })).toBe(true);
  expect(originalStandsIn({ ...heic, bytes: 6 * 1024 * 1024 })).toBe(false);
  expect(originalStandsIn({ mimeType: "image/tiff", name: "scan.tiff", bytes: 215_000 })).toBe(
    false,
  );
});
