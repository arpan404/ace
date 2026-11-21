import { expect, test } from "vitest";
import {
  drawnAsPicture,
  originalStandsIn,
  pictureBytes,
  pictureLine,
} from "./attachment-picture.ts";

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

const ftyp = (brand: string) =>
  Uint8Array.from([0, 0, 0, 24, ...Buffer.from(`ftyp${brand}`), 0, 0, 0, 0]);

test.each([
  ["PNG", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])],
  ["JPEG", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])],
  ["GIF", Buffer.from("GIF89a....")],
  ["WebP", Buffer.from("RIFF\0\0\0\0WEBPVP8 ")],
  ["HEIC", ftyp("heic")],
  ["HEIF", ftyp("mif1")],
  ["TIFF, little-endian", Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 8])],
  ["TIFF, big-endian", Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, 8])],
  ["BMP", Buffer.from("BM6\0\0\0\0\0\0\0\x36\0\0\0")],
])("%s bytes are a picture the phone may decode", (_, bytes) => {
  expect(pictureBytes(bytes)).toBe(true);
});

test.each([
  ["an SVG named drawing.heic", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ["a video's ftyp", ftyp("isom")],
  ["text", Buffer.from("heic bytes")],
  ["nothing", new Uint8Array()],
])("%s is not a picture", (_, bytes) => {
  expect(pictureBytes(bytes)).toBe(false);
});

test("a picture past 8 MiB is a file to open, not drawn inline, even with a preview", () => {
  const png = { mimeType: "image/png", name: "huge.png", thumbnailAvailable: true };
  expect(pictureLine({ ...png, bytes: 2 * 1024 * 1024 })).toEqual({ kind: "image", drawn: true });
  expect(pictureLine({ ...png, bytes: 9 * 1024 * 1024 })).toEqual({ kind: "image", drawn: false });
  expect(pictureLine({ mimeType: "text/plain", name: "a.txt", bytes: 10, kind: "text" })).toEqual({
    kind: "text",
    drawn: false,
  });
});
