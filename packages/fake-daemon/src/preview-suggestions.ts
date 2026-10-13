import type { PreviewSuggestion } from "@ace/protocol";

/*
 * The dev servers the fake daemon reports as detected for every thread, so the New tab and the
 * Preview empty state show suggestion tiles in fake mode and in screenshots.
 */

const svg = (markup: string) => `data:image/svg+xml,${encodeURIComponent(markup)}`;

const viteIcon = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#41d1ff"/><stop offset="1" stop-color="#bd34fe"/></linearGradient></defs><path fill="url(#a)" d="M30 5 16.6 29a.8.8 0 0 1-1.3 0L2 5a.8.8 0 0 1 .8-1.1L16 6.3l13.2-2.4A.8.8 0 0 1 30 5Z"/><path fill="#ffd62e" d="M22.6 1 12.8 2.9a.4.4 0 0 0-.3.3l-.6 10.2a.4.4 0 0 0 .4.4l2.7-.6a.4.4 0 0 1 .5.5l-.8 3.9a.4.4 0 0 0 .5.4l1.7-.5a.4.4 0 0 1 .5.5l-1.3 6.3c-.1.4.4.6.6.3l.2-.2 7.4-14.8a.4.4 0 0 0-.4-.5l-2.8.5a.4.4 0 0 1-.5-.5l1.8-6.3a.4.4 0 0 0-.5-.5Z"/></svg>',
);

const nextIcon = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#000"/><path fill="#fff" d="M11 10h2.2l8.6 12.6-1.6 1.1L13.2 13.9V22H11Z"/><path fill="#fff" d="M19 10h2v8.4l-2-3Z"/></svg>',
);

export function fakePreviewSuggestions(): PreviewSuggestion[] {
  return [
    {
      port: 5173,
      url: "http://localhost:5173/",
      title: "Vite + React + TS",
      iconUrl: viteIcon,
      source: "terminal",
    },
    {
      port: 3000,
      url: "http://localhost:3000/",
      title: "Next.js",
      iconUrl: nextIcon,
      source: "listener",
    },
  ];
}
