# 0104: Who owns a browser tab's device

Date: 2026-10-26. Status: accepted.

## Context

A tab's page has one viewport. Several screens can watch it at once: the desktop app beside the thread, the web app, the phone. Agents can drive it too. Each can size the page: a pane's size (`resize`), a device from the device toolbar (`emulate`), or an agent's own `emulate` or `resize`. The daemon keeps the result as `BrowserTab.emulation` with who set it (`by: "human" | "agent"`, ADR 0067), and a person's plain `resize` clears it.

The phone added a third kind of size. Its view is narrow and tall, so a page laid out at a desktop pane's size is unreadable there, and the phone needs a mobile page by default. Without a rule, the screens fight:

- the phone's default replaced a device an agent or the desktop had chosen;
- the desktop undid a device chosen on another screen by sending its pane size again, on every state change, on a reconnect, or when a panel mounted;
- an agent working in the tab didn't know its page had become a phone's.

## Decision

**A tab's device belongs to whoever chose it last, and every screen shows it.** No screen replaces a device it didn't choose, except when the person on that screen picks one.

1. **A device set elsewhere is shown, not undone.** When a tab emulates a device that a screen didn't ask for (an agent's, or the person's on another screen), that screen shows it: the web opens its device toolbar at that device, and the phone names it in its own. A screen remembers only its own asks still in flight, per tab, and treats one that lands as its own. Any other device that arrives belongs to someone else.
2. **The pane never resizes a tab with a device.** A pane sends its size only while the tab shows no device. It waits until it has the tab's current state (after a subscribe or a reconnect), so a device set while it was away is not cleared by an older picture of the tab. Closing the device toolbar on a screen is the only way that screen takes the pane's size back.
3. **The phone opens a tab as "this phone", once.** A tab with no device gets the phone's automatic device the first time the phone shows it. That device is the phone view's own width and height, with the scale, touch and user agent of the iPhone preset nearest its width, so the whole page fits the view. It follows the view's size while the tab still shows it. The phone remembers per tab, on the phone, that it did this. If such a tab has no device later, someone removed it (the desktop closed its toolbar), and the phone leaves the page as it is and shows "Responsive". After that, only the person's picks on the phone send a device. This holds across reconnects, reopening the view and tab switches.
4. **Agents are told.** Agents' tab results (`browser_tabs`, `browser_open`) and screenshot metadata include the tab's device (`width`, `height`, `mobile`, `touch`, `setBy`). An agent can therefore tell it is working at a person's phone viewport. Agents keep their own `emulate` and `resize`, and the same rule applies to them: the person's screens show an agent's device rather than undoing it.

The person's own Chrome (`backend: "user"`, ADR 0084) is theirs: no screen sends it a device.

The pure parts live in `@ace/ui-core/browser-devices`: presets, `emulationMatches`, `openingDevice` and `phoneFitEmulation`. Per-tab settings live in `@ace/ui-core/browser-device-settings`. The web keeps the settings in local storage and the phone in its app store (`storage.devices.*`).

## Consequences

- Opening a tab with no device on the phone does change what the desktop shows. The desktop names the device in its own toolbar rather than changing silently, and closing that toolbar gives the desktop its pane back for good, because the phone won't send its automatic device to that tab again.
- A daemon restart that loses a tab's device leaves the phone showing the tab at whatever size it has. The person can pick "This phone" again.
- The phone's stream is encoded for the picture as drawn: the page fits the phone's width and can be zoomed, so the phone reports the drawn size in `browser.capture`, not the bare view.
- Rejected: tagging each emulation with the requesting connection, which would let a screen tell its own device from another's exactly. It needs a protocol change and daemon bookkeeping. The per-tab list of asks still in flight covers the cases seen so far. Revisit if screens still disagree.
