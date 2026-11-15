import type { SuitOrnamentSlot } from "@ace/protocol/suit-parts";
import type { SuitDetail } from "@ace/protocol/suits";
import type { Scheme } from "@ace/themes";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn.ts";
import { suitFontFaces, suitSchemeFor } from "@/theme/suits/suit-css.ts";
import { defaultLabels, suitLabel } from "@/theme/suits/suit-labels.ts";
import { previewHeight, previewWidth, suitPreviewSheet } from "./suit-preview-sheet.ts";

/*
 * A Suit as it looks, in miniature (ADR 0150), for Settings > Appearance: the mode cards, the
 * Custom card and every Suit in the list. It is a small ace window built from the published
 * parts (rail, sidebar with an open thread row, header, a user message, an answer, a tool row,
 * the Working line, the composer) with the Suit's own tokens, suit.css, labels and ornaments.
 *
 * Why a live miniature and not a screenshot the Suit ships: it can never go stale against the
 * Suit's files (an agent's every save redraws it), it needs nothing from the Suit's author, and
 * it shows the Suit in the scheme asked for. It is robust because it lives in a shadow root: the
 * Suit on screen can't restyle another Suit's miniature (its rules match any descendant of
 * `<html data-suit>`, and selectors don't cross into a shadow root), and the app's utilities
 * can't either; the root's sheet (`suit-preview-sheet.ts`) is all it draws with. It is laid out
 * at a real window size and scaled to its card, so the Suit's pixel sizes keep their
 * proportions. Font files can't be declared inside a shadow root, so the Suit's faces go on the
 * page beside it; scenes don't run in it (the frame colour shows instead).
 */

/** A Suit's ornament in the miniature: markup the daemon sanitised, as the app shows it. */
function Ornament(props: { detail: SuitDetail; slot: SuitOrnamentSlot }) {
  const markup = props.detail.ornaments[props.slot];
  if (!markup) return null;
  // Sanitised by the daemon, which this build trusts (ADR 0125), as `SuitOrnament` shows it.
  return (
    <div aria-hidden data-ornament={props.slot} dangerouslySetInnerHTML={{ __html: markup }} />
  );
}

const corners: SuitOrnamentSlot[] = [
  "corner-top-left",
  "corner-top-right",
  "corner-bottom-left",
  "corner-bottom-right",
];

function Window(props: { detail: SuitDetail; scheme: Scheme; scale: number; clip?: string }) {
  const { detail } = props;
  const labels = detail.manifest.labels;
  const send = suitLabel(labels, "send", defaultLabels.send);
  return (
    <div
      className="frame"
      data-suit={detail.manifest.id}
      data-scheme={suitSchemeFor(detail.manifest, props.scheme)}
      style={{ transform: `scale(${props.scale})`, clipPath: props.clip }}
    >
      <div data-part="app" data-page="thread">
        {corners.map((slot) => (
          <Ornament key={slot} detail={detail} slot={slot} />
        ))}
        <div data-part="rail">
          <span data-part="rail-item" data-state="active">
            <i />
          </span>
          <span data-part="rail-item">
            <i />
          </span>
          <span data-part="rail-item">
            <i />
          </span>
        </div>
        <div data-part="sidebar">
          <div data-part="sidebar-header">
            <Ornament detail={detail} slot="sidebar-header" />
            {!detail.ornaments["sidebar-header"] && <span>Threads</span>}
          </div>
          <div data-part="thread-list">
            <span data-part="thread-row" data-state="active">
              <span data-part="status-icon" data-state="working" />
              <span data-part="thread-title">Add sign-in links</span>
              <span data-part="thread-meta">2m</span>
            </span>
            <span data-part="thread-row" data-state="unread">
              <span data-part="status-icon" data-state="waiting" />
              <span data-part="thread-title">Review the cache change</span>
            </span>
            <span data-part="thread-row">
              <span data-part="status-icon" data-state="done" />
              <span data-part="thread-title">Fix the flaky upload test</span>
            </span>
          </div>
          <Ornament detail={detail} slot="sidebar-footer" />
          <div data-part="sidebar-footer" />
        </div>
        <div data-part="main">
          <div data-part="header">
            <span data-part="header-title">Add sign-in links</span>
          </div>
          <div data-part="page" data-page="thread">
            <div data-part="transcript">
              <div className="column">
                <div data-part="message-user">Send people a sign-in link by email.</div>
                <div data-part="message-agent">
                  <p>
                    Done. The page now sends a one-time link, and opening it signs you in.{" "}
                    <span data-part="link">See the change</span>.
                  </p>
                </div>
                <div data-part="tool-row" data-variant="edit" data-state="done">
                  Edited <span data-part="inline-code">sign-in.tsx</span>
                </div>
                <div data-part="working-line" data-state="working">
                  {suitLabel(labels, "working-word", defaultLabels["working-word"])} for 12s
                </div>
              </div>
            </div>
            <div data-part="composer">
              <Ornament detail={detail} slot="composer-top" />
              <div data-part="composer-input">
                {suitLabel(labels, "composer-placeholder", defaultLabels["composer-placeholder"])}
              </div>
              <div data-part="composer-toolbar">
                <span data-part="model-picker">Model</span>
                <span data-part="composer-send" data-variant="send">
                  {send === defaultLabels.send ? "↑" : send}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Renders `children` into an open shadow root of the span it returns. */
function Shadow(props: { children: ReactNode; onWidth(width: number): void }) {
  const host = useRef<HTMLSpanElement>(null);
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  const { onWidth } = props;
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    setRoot(element.shadowRoot ?? element.attachShadow({ mode: "open" }));
    onWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(([entry]) => entry && onWidth(entry.contentRect.width));
    watch.observe(element);
    return () => watch.disconnect();
  }, [onWidth]);
  return (
    <span ref={host} data-suit-preview="" className="absolute inset-0 block">
      {root && createPortal(props.children, root)}
    </span>
  );
}

/**
 * `detail` as the app draws it in one scheme, or split down a diagonal with light on the left
 * and dark on the right. Fills its parent's width at 16:9 unless `className` says otherwise.
 */
export function SuitPreview(props: {
  detail: SuitDetail;
  scheme: Scheme | "split";
  className?: string;
}) {
  const { detail } = props;
  // The card's width over the miniature's: a card not laid out yet (or in tests) draws at 0.2.
  const [scale, setScale] = useState(0.2);
  const [onWidth] = useState(
    () => (width: number) => width > 0 && setScale(Math.round((width / previewWidth) * 1e4) / 1e4),
  );
  const { scheme } = props;
  const split = scheme === "split";
  return (
    <span
      aria-hidden
      data-suit-miniature={detail.manifest.id}
      style={{ aspectRatio: `${previewWidth} / ${previewHeight}` }}
      className={cn(
        "relative block overflow-hidden rounded-lg border border-border transition-[border-color] duration-(--motion-base) group-hover:border-border-strong group-aria-checked:border-transparent",
        props.className,
      )}
    >
      {/* Font files can't be declared inside a shadow root: the Suit's faces live on the page. */}
      <style>{suitFontFaces(detail).join("\n")}</style>
      <Shadow onWidth={onWidth}>
        <style>{suitPreviewSheet(detail)}</style>
        <Window detail={detail} scheme={scheme === "split" ? "light" : scheme} scale={scale} />
        {split && (
          <Window
            detail={detail}
            scheme="dark"
            scale={scale}
            clip="polygon(62% 0, 100% 0, 100% 100%, 38% 100%)"
          />
        )}
      </Shadow>
    </span>
  );
}
