import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type GitHubIssueThread,
} from "@ace/contracts";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";

const MARKDOWN_IMG = /!\[[^\]]*]\(([^)\s]+)\)/g;
const HTML_IMG = /<img[^>]+src=["']([^"'>\s]+)["']/gi;

const ALLOWED_HOST_SUFFIXES = ["github.com", "githubusercontent.com", "githubassets.com"];

function isAllowedImageUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

function resolveImageHref(href: string, issueUrl: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    if (trimmed.startsWith("//")) {
      const url = new URL(`https:${trimmed}`);
      return isAllowedImageUrl(url) ? url.toString() : null;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      return isAllowedImageUrl(url) ? url.toString() : null;
    }
    const base = new URL(issueUrl);
    const url = new URL(trimmed, `${base.origin}/`);
    return isAllowedImageUrl(url) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function collectMarkdownImageUrlsFromThread(thread: GitHubIssueThread): string[] {
  const chunks: string[] = [];
  if (thread.body) {
    chunks.push(thread.body);
  }
  for (const comment of thread.comments) {
    if (comment.body) {
      chunks.push(comment.body);
    }
  }
  const text = chunks.join("\n\n");
  const seen = new Set<string>();
  const ordered: string[] = [];

  const push = (raw: string) => {
    const resolved = resolveImageHref(raw, thread.url);
    if (!resolved || seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    ordered.push(resolved);
  };

  for (const match of text.matchAll(MARKDOWN_IMG)) {
    const g = match[1];
    if (g) {
      push(g);
    }
  }
  let htmlMatch: RegExpExecArray | null;
  HTML_IMG.lastIndex = 0;
  while ((htmlMatch = HTML_IMG.exec(text)) !== null) {
    const g = htmlMatch[1];
    if (g) {
      push(g);
    }
  }

  return ordered.slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
}

function extensionFromMime(mime: string): string {
  if (mime === "image/png") {
    return "png";
  }
  if (mime === "image/jpeg" || mime === "image/jpg") {
    return "jpg";
  }
  if (mime === "image/gif") {
    return "gif";
  }
  if (mime === "image/webp") {
    return "webp";
  }
  return "img";
}

export async function fetchGitHubIssueMarkdownImages(
  thread: GitHubIssueThread,
): Promise<ComposerImageAttachment[]> {
  const urls = collectMarkdownImageUrlsFromThread(thread);
  const attachments: ComposerImageAttachment[] = [];

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]!;
    try {
      const response = await fetch(url, { credentials: "omit", mode: "cors" });
      if (!response.ok) {
        continue;
      }
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) {
        continue;
      }
      if (blob.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        continue;
      }
      const ext = extensionFromMime(blob.type);
      const file = new File([blob], `github-issue-${thread.number}-${index + 1}.${ext}`, {
        type: blob.type,
      });
      const previewUrl = URL.createObjectURL(file);
      attachments.push({
        type: "image",
        id: randomUUID(),
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
    } catch {
      continue;
    }
  }

  return attachments;
}
