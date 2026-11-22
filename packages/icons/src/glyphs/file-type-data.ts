/**
 * File types of documents, data and media: Markdown, YAML, TOML, SQL, GraphQL, CSV, images,
 * video, audio, PDF, archives, plain text and env files. ace's own drawings (ADR 0156).
 */
import { glyph } from "../glyph.ts";
import { polygon, polyline, rect } from "../geometry.ts";
import { circle, detail, dot, line, shape, spot } from "../parts.ts";
import { database } from "./database.ts";
import { page } from "./file.ts";
import { image } from "./image.ts";
import { key } from "./key.ts";
import { layoutMark, textMark } from "./file-marks.ts";

/** Markdown: a heading's hash on a wide card. */
export const MarkdownFileIcon = /* @__PURE__ */ glyph("MarkdownFile", () => [
  shape(rect(2.5, 5, 19, 14, 4)),
  detail("M10.6 8.75 9.9 15.25M14.6 8.75 13.9 15.25M7.75 10.75h9M7.25 13.25h9"),
]);

/** YAML: an indented list, a key and its two children. */
export const YamlFileIcon = /* @__PURE__ */ glyph("YamlFile", () => [
  dot(4.75, 6, 1.6),
  line("M8.25 6h12"),
  dot(9.25, 12, 1.6),
  line("M12.75 12h7.5"),
  dot(9.25, 18, 1.6),
  line("M12.75 18h7.5"),
]);

/** TOML and other settings files: a table's square brackets around its keys. */
export const TomlFileIcon = /* @__PURE__ */ glyph("TomlFile", () => [
  line(
    polyline([
      [7, 4],
      [3.75, 4, 1.25],
      [3.75, 20, 1.25],
      [7, 20],
    ]),
  ),
  line(
    polyline([
      [17, 4],
      [20.25, 4, 1.25],
      [20.25, 20, 1.25],
      [17, 20],
    ]),
  ),
  line("M8.5 9.5h7M8.5 14.5h4.5"),
]);

/** SQL: a database. */
export const SqlFileIcon = /* @__PURE__ */ glyph("SqlFile", database);

/** GraphQL: a graph of three nodes. */
export const GraphqlFileIcon = /* @__PURE__ */ glyph("GraphqlFile", () => [
  shape(
    polygon([
      [12, 4.5, 1],
      [19.25, 17.25, 1],
      [4.75, 17.25, 1],
    ]),
  ),
  spot(circle(12, 4.25, 2.4)),
  spot(circle(19.5, 17.5, 2.4)),
  spot(circle(4.5, 17.5, 2.4)),
]);

/** Tables: a grid of cells with a header row. */
export const CsvFileIcon = /* @__PURE__ */ glyph("CsvFile", () => [
  shape(rect(3, 4, 18, 16, 4)),
  detail("M3.4 9.25h17.2M3.4 14.5h17.2M9.75 9.25v10.35"),
]);

/** Images: a picture of a hill under a sun. */
export const ImageFileIcon = /* @__PURE__ */ glyph("ImageFile", image);

/** Video: a camera, its lens to the right. */
export const VideoFileIcon = /* @__PURE__ */ glyph("VideoFile", () => [
  shape(rect(2.5, 5.5, 13.5, 13, 3.75)),
  shape(
    polygon([
      [16.5, 10, 0.8],
      [21.5, 7, 1.25],
      [21.5, 17, 1.25],
      [16.5, 14, 0.8],
    ]),
  ),
]);

/** Audio: a pair of joined notes. */
export const AudioFileIcon = /* @__PURE__ */ glyph("AudioFile", () => [
  shape(circle(6.5, 17.75, 2.75)),
  shape(circle(17, 15.75, 2.75)),
  line(
    polyline([
      [9.25, 17.75],
      [9.25, 5.25, 1],
      [19.75, 3.25, 1],
      [19.75, 15.75],
    ]),
  ),
  line("M9.25 9.25 19.75 7.25"),
]);

/** PDF: a page set out as print, a picture over a line. */
export const PdfFileIcon = /* @__PURE__ */ glyph("PdfFile", () => [...page(), ...layoutMark()]);

/** Archives: a box closed by a zipper, its pull hanging. */
export const ArchiveFileIcon = /* @__PURE__ */ glyph("ArchiveFile", () => [
  shape(rect(3.5, 3, 17, 18, 4.5)),
  detail("M10.5 3.4h1.5M12 6h1.5M10.5 8.6h1.5"),
  spot(rect(10.25, 11.25, 3.5, 5.5, 1.5)),
]);

/** Plain text: a page of left-aligned lines. */
export const TextFileIcon = /* @__PURE__ */ glyph("TextFile", () => [...page(), ...textMark()]);

/** A file of any other type: the page. */
export const PlainFileIcon = /* @__PURE__ */ glyph("PlainFile", page);

/** Env files: a key, for the secrets they hold. */
export const EnvFileIcon = /* @__PURE__ */ glyph("EnvFile", key);
