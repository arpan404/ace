import SwiftUI

/// What the transcript's collection view reports: its phases, its geometry and its rows.
extension ConversationFeed {
    func scrollEvents(_ proxy: TranscriptSurface) -> TranscriptCollectionEvents {
        TranscriptCollectionEvents(
            phase: { old, phase, geometry, velocity in scrollPhaseChanged(from: old, to: phase, geometry: geometry, velocity: velocity, proxy: proxy) },
            geometry: { old, new in scrollGeometryChanged(from: Self.metrics(old), to: Self.metrics(new), proxy: proxy) },
            rowLaidOut: { id, frame in rowLaidOut(id, frame: TranscriptScrollAxis.row(frame), proxy: proxy) },
            rowAppeared: { _ in
                ThreadOpenTrace.shared.painted(thread.id); PerfProbe.add("rows.appeared", 1); PerfCounters.bump("row.appear")
                if !rowsPainted { rowsPainted = true }
            },
            rowGone: { id in keep(.gone(id), proxy: proxy); PerfCounters.bump("row.disappear") },
            placeKept: { by in TranscriptJumpHooks.note("join kept \(Int(by))") })
    }

    /// The scroll's physical geometry in the feed's terms: `y` and the distances in screen order.
    static func metrics(_ geometry: TranscriptScrollGeometry) -> TranscriptScrollIntent.Metrics {
        let distance = TranscriptScrollAxis.distances(offset: geometry.offset, content: geometry.contentHeight,
                                                      viewport: geometry.viewport, startInset: 0)
        return TranscriptScrollIntent.Metrics(y: -geometry.offset, top: distance.older, bottom: distance.live,
                                              viewport: geometry.viewport, topInset: 0, bottomInset: 0, height: geometry.contentHeight)
    }

    func scrollPhaseChanged(from old: TranscriptScrollPhase, to phase: TranscriptScrollPhase, geometry: TranscriptScrollGeometry,
                            velocity: Double?, proxy: TranscriptSurface) {
        intent.flingProbe.phase(from: old, to: phase, geometry: geometry, velocity: velocity,
                                holdingEnd: holdsEnd && !TranscriptFlingProbe.suppressesAnchors)
        transcriptMarkdown?.moving = phase != .idle
        timePillPhase(phase)
        if TranscriptFlingProbe.isolated, phase == .tracking || phase == .interacting {
            intent.isolatingFling = true
            readerMovedFeed()
            settle.cancel()
            if following { setFollowing(false) }
        }
        if intent.isolatingFling { return }
        // The hold only moves a feed at rest; any scroll it didn't make (a finger, VoiceOver's
        // three-finger swipe, Switch Control) ends it where the reader is.
        if surface.running(.page), phase != .idle { endPageHold() }
        switch phase {
        case .tracking:
            readerMovedFeed()
            settle.cancel()
            viewport.cancelPending()
            readerTookOver(proxy)
            model.beginReadingScroll()
            intent.begin()
            keep(.phase(.gesture), proxy: proxy)
        // A quick drag can skip tracking: a new gesture is one that starts from rest.
        case .interacting where old == .idle || old == .decelerating || old == .animating:
            readerMovedFeed()
            settle.cancel()
            viewport.cancelPending()
            readerTookOver(proxy)
            model.beginReadingScroll()
            intent.begin(); intent.active = true
            keep(.phase(.gesture), proxy: proxy)
        case .interacting, .decelerating:
            intent.active = true
            keep(.phase(.gesture), proxy: proxy)
        case .idle:
            // Only the person's own scroll decides whether the feed follows the end; the
            // feed's animated scrolls (the keyboard, the composer) settle while text streams.
            let touched = intent.active
            intent.active = false
            model.endReadingScroll()
            if touched {
                let atEnd = intent.metrics.bottom <= AceDesign.Space.group
                let live = reading.thread == nil || reading.joined
                setFollowing(atEnd && live)
                endRead(moving: false)
            } else if TranscriptEndButton.leftByOtherScroll(following: pinned, fromEnd: Double(intent.metrics.bottom),
                                                            viewport: Double(intent.metrics.viewport),
                                                            settling: settle.isRunning || keyboardMoving) {
                // A scroll that wasn't the person's drag (the status bar's tap to the top,
                // VoiceOver) left the end far behind: stop following, as a drag would.
                setFollowing(false)
            }
            // An assistive scroll (VoiceOver's three-finger swipe, Switch Control) is the
            // reader's own though no finger tracked it; the feed's own scrolls are excluded.
            if !touched, old == .animating || old == .decelerating, !settle.isRunning, !keyboardMoving,
               Self.assistiveScrolling {
                readerTookOver(proxy)
            }
            // After the follow mode above: where the scroll came to rest is held, and a
            // correction owed while it ran is made (`TranscriptPlaceKeeper`).
            keep(.phase(.idle), proxy: proxy)
            updateBehind()
            pageIfNeeded(proxy)
        case .animating:
            keep(.phase(.animating), proxy: proxy)
            // A scroll that never reports its end still lets an owed correction run.
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(Int(TranscriptPlaceKeeper.animationLimit)))
                keep(.tick, proxy: proxy)
            }
        }
        intent.animating = phase == .animating
        TranscriptJumpHooks.scrolling(phase)
    }

    func scrollGeometryChanged(from old: TranscriptScrollIntent.Metrics, to new: TranscriptScrollIntent.Metrics, proxy: TranscriptSurface) {
        PerfCounters.bump("scroll.geometry")
        intent.flingProbe.geometry()
        if intent.isolatingFling { return }
        intent.metrics = new
        let origin = TranscriptScrollAxis.origin(offset: -new.y, viewport: new.viewport)
        if origin != anchor.keeper.frames.origin { contentScrolled(to: origin, proxy: proxy) }
        if timeMarker.scrolling { markTopTime() }
        if new.height != old.height { PerfCounters.bump("content.height") }
        let opened = intent.opened
        if intent.opened, new.height != old.height {
            // What opened grows under the row the person tapped, which stays put; the feed
            // follows the end again only if the end is still in view.
            intent.opened = false
            if reading.thread == nil { setFollowing(new.bottom <= AceDesign.Space.group) }
        }
        // Following, an end that grew past the bottom (a streaming answer) is followed from
        // here: the lazy tail row that also scrolls on each change isn't built once the end
        // is a screen away, so one burst of growth would otherwise leave it behind for good.
        if !opened, pinned, thread.loaded, !intent.active, !keyboardMoving,
           new.height > old.height, new.bottom > 1 { toEnd(proxy) }
        // Geometry is an observation, not a new scroll request. The bounded correction
        // already handles lazy-row remeasurement after a content or composer change.
        if thread.loaded, new.bottom <= 1 { ThreadOpenTrace.shared.settled(thread.id) }
        // Content that shrank under a still feed left it past its end: back to the real end,
        // so the rows show instead of the dark below them.
        if thread.loaded, TranscriptScrollIntent.Metrics.strandedPastEnd(old: old, new: new, moving: intent.active || intent.animating) {
            surface.scroll(to: TranscriptTail.id, anchor: .top)
        }
        // Scroll to end follows the end's distance as it changes, mid-drag included: it floats
        // over the composer, so showing it moves nothing under the rows.
        defer { updateBehind() }
        if intent.active {
            // Leaving the end stops following at once; the bridge is told to hold the rows
            // once the reader is a screen away (`endRead`). The viewport is view state:
            // write it only when it changes, or every frame of a scroll re-evaluates the
            // whole feed.
            if new.y < old.y - 1 {
                if intent.rearmAfterAppend {
                    intent.rearmAfterAppend = false
                    intent.consumed = false
                }
                intent.direction = -1
                if following { setFollowing(false) }
            }
            else if new.y > old.y + 1 { intent.direction = 1 }
            endRead(moving: true)
            pageIfNeeded(proxy)
        }
    }
}
