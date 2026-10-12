import { fileLanguage } from "@ace/ui-core";

/** What a fence's info string says: its language, the file it shows, and whether it's a diff. */
export interface FenceInfo {
  lang: string | undefined;
  file: string | undefined;
  diff: boolean;
}

const named = /\b(?:title|file|filename|name)=(?:"([^"]+)"|'([^']+)'|(\S+))/;
/** A path (has a slash) or a file name with an extension, not a language like `c++`. */
const pathLike = (word: string) =>
  /[\\/]/.test(word) || /^[\w.-]*[A-Za-z_-][\w-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(word);

/**
 * Read a fence's info string (marked keeps all of it): `ts`, `ts title="src/a.ts"`,
 * `ts:src/a.ts`, `ts src/a.ts` or just `src/a.ts`, whose extension names the language.
 */
export function fenceInfo(info: string | undefined): FenceInfo {
  const text = info?.trim() ?? "";
  if (!text) return { lang: undefined, file: undefined, diff: false };
  const attribute = named.exec(text);
  let file = attribute?.[1] ?? attribute?.[2] ?? attribute?.[3];
  const words = (attribute ? text.replace(attribute[0], " ") : text).split(/\s+/).filter(Boolean);
  let lang = words[0];
  const colon = lang?.indexOf(":") ?? -1;
  if (lang && colon > 0 && !file) {
    file = lang.slice(colon + 1) || undefined;
    lang = lang.slice(0, colon);
  }
  if (!file && words[1] && pathLike(words[1])) file = words[1];
  if (lang && !file && pathLike(lang)) {
    file = lang;
    lang = undefined;
  }
  lang ??= file ? fileLanguage(file) : undefined;
  const lower = lang?.toLowerCase();
  const diff = lower === "diff" || lower === "patch" || (!!file && /\.(diff|patch)$/i.test(file));
  return { lang, file, diff };
}
