import { Fragment, useEffect, useState } from "react";
import { emojiFile, splitEmoji } from "@/lib/emoji.ts";
import { cn } from "@/lib/cn.ts";
import { spadeQuickReactions } from "@ace/ui-core/spade-chat";
import thumbsUp from "@twemoji/svg/1f44d.svg";
import heart from "@twemoji/svg/2764.svg";
import laughing from "@twemoji/svg/1f602.svg";
import surprised from "@twemoji/svg/1f62e.svg";
import folded from "@twemoji/svg/1f64f.svg";
import thumbsDown from "@twemoji/svg/1f44e.svg";

/*
 * Emoji as Twemoji images (jdecked/twemoji, graphics CC-BY 4.0; see NOTICE), so they look the
 * same on macOS, Windows, Linux and iPhone web. The reaction picker's six ship with the app; any
 * other loads from the local bundle by codepoint when first drawn. The real character stays as
 * the image's alt text, so copy and paste and screen readers get it; one that has no image shows
 * as the system's own glyph.
 */

const shipped: Record<string, string> = {
  [emojiFile(spadeQuickReactions[0])]: thumbsUp,
  [emojiFile(spadeQuickReactions[1])]: heart,
  [emojiFile(spadeQuickReactions[2])]: laughing,
  [emojiFile(spadeQuickReactions[3])]: surprised,
  [emojiFile(spadeQuickReactions[4])]: folded,
  [emojiFile(spadeQuickReactions[5])]: thumbsDown,
};

/** Every other emoji, fetched from the bundle on first use. */
const lazy = import.meta.glob<string>("/node_modules/@twemoji/svg/*.svg", {
  query: "?url",
  import: "default",
});

const found = new Map<string, string | null>();

/** The image address of an emoji: at once for the picker's, else after loading its file. */
function useEmojiSource(emoji: string): string | null | undefined {
  const file = emojiFile(emoji);
  const [loaded, setLoaded] = useState<{ file: string; url: string | null }>();
  const known = shipped[file] ?? found.get(file);
  useEffect(() => {
    if (known !== undefined) return;
    let live = true;
    const load = lazy[`/node_modules/@twemoji/svg/${file}.svg`] ?? (() => Promise.reject());
    load().then(
      (url) => {
        found.set(file, url);
        if (live) setLoaded({ file, url });
      },
      () => {
        found.set(file, null);
        if (live) setLoaded({ file, url: null });
      },
    );
    return () => {
      live = false;
    };
  }, [file, known]);
  if (known !== undefined) return known;
  return loaded?.file === file ? loaded.url : undefined;
}

/** One emoji, sized to the text around it (1.1em) unless `className` says otherwise. */
export function Emoji(props: { emoji: string; className?: string }) {
  const source = useEmojiSource(props.emoji);
  // Until its image is known, and for one with none, the character itself holds the place.
  if (!source) return <span className={props.className}>{props.emoji}</span>;
  return (
    <img
      src={source}
      alt={props.emoji}
      draggable={false}
      className={cn("inline-block size-[1.1em] align-[-0.2em]", props.className)}
    />
  );
}

/** Words with their emoji drawn as images; the rest of the text is left as it is. */
export function WithEmoji(props: { text: string }) {
  return splitEmoji(props.text).map((part, index) => (
    // The parts are positional and never reorder.
    // eslint-disable-next-line react/no-array-index-key
    <Fragment key={index}>
      {part.kind === "emoji" ? <Emoji emoji={part.text} /> : part.text}
    </Fragment>
  ));
}
