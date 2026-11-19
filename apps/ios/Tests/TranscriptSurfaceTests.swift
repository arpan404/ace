import Testing
@testable import Ace

/// The transcript's reveal on open and an older page's hold settle on their own: one starting
/// never cancels the other, so a page that lands while the thread is still hidden can't leave it
/// hidden for good (`TranscriptSurface`).
@MainActor @Suite struct TranscriptSurfaceTests {
    @Test func aPageLandingMidRevealLetsBothFinish() {
        let surface = TranscriptSurface()
        var revealed: TranscriptSettle.Outcome?
        var held: TranscriptSettle.Outcome?
        var reveal = TranscriptSettle(at: 0)
        surface.untilSettled(.reveal, { reveal.frame([2_000], at: $0) }) { revealed = $0 }
        surface.drawn(at: 0.016)
        // The reader paged back at once: the page lands while the open is still hidden.
        var page = TranscriptSettle(at: 0.02)
        var top = 400.0
        surface.untilSettled(.page, { time in
            top -= 100
            return page.frame([top], at: time)
        }) { held = $0 }
        for frame in 2...30 { surface.drawn(at: Double(frame) * 0.016) }
        // The hold ran to its limit, so the open showed at its own limit rather than mid-hold.
        #expect(revealed == .capped, "the open showed though a page landed during it")
        #expect(held == .capped, "the page's hold ran to its own end")
        #expect(!surface.running(.reveal) && !surface.running(.page))
    }

    @Test func anOpeningWaitsForAPageHoldStillPlacingItsRow() throws {
        let surface = TranscriptSurface()
        var now = 0.0
        var revealedAt: Double?
        var heldAt: Double?
        var reveal = TranscriptSettle(at: 0)
        surface.untilSettled(.reveal, { reveal.frame([2_000], at: $0) }) { _ in revealedAt = now }
        // A page landed while the feed is hidden: its row is put back over six frames.
        var page = TranscriptSettle(at: 0)
        var drift = 120.0
        surface.untilSettled(.page, { time in
            drift = max(0, drift - 20)
            return page.frame([drift], placed: drift == 0, at: time)
        }) { _ in heldAt = now }
        for frame in 1...20 {
            now = Double(frame) * 0.016
            surface.drawn(at: now)
        }
        let held = try #require(heldAt)
        let revealed = try #require(revealedAt)
        #expect(revealed > 0.05, "the reveal alone would have settled on the third frame")
        #expect(revealed >= held, "the feed showed only once the page's row was back in place")
    }

    @Test func aPageHoldOutlastingTheLimitDoesntKeepTheOpeningHidden() {
        let surface = TranscriptSurface()
        var revealed: TranscriptSettle.Outcome?
        var reveal = TranscriptSettle(at: 0)
        surface.untilSettled(.reveal, { reveal.frame([2_000], at: $0) }) { revealed = $0 }
        surface.untilSettled(.page, { _ in .waiting }) { _ in }
        var time = 0.0
        while revealed == nil, time < 1 {
            time += 0.016
            surface.drawn(at: time)
        }
        #expect(revealed == .capped)
        #expect(time >= 0.25 && time < 0.27, "shown at the limit: \(time)")
    }

    @Test func stoppingAPageHoldLeavesTheRevealRunning() {
        let surface = TranscriptSurface()
        var revealed = false
        var reveal = TranscriptSettle(at: 0)
        surface.untilSettled(.reveal, { reveal.frame([2_000], at: $0) }) { _ in revealed = true }
        var page = TranscriptSettle(at: 0)
        surface.untilSettled(.page, { page.frame([], placed: false, at: $0) }) { _ in }
        surface.stop(.page)
        for frame in 1...4 { surface.drawn(at: Double(frame) * 0.016) }
        #expect(revealed)
        #expect(!surface.running(.page))
    }

    @Test func startingARunAgainReplacesOnlyThatRun() {
        let surface = TranscriptSurface()
        var first = false
        var second = false
        var revealed = false
        var reveal = TranscriptSettle(at: 0)
        surface.untilSettled(.reveal, { reveal.frame([1], at: $0) }) { _ in revealed = true }
        surface.untilSettled(.page, { _ in .waiting }) { _ in first = true }
        surface.untilSettled(.page, { _ in .settled }) { _ in second = true }
        for frame in 1...4 { surface.drawn(at: Double(frame) * 0.016) }
        #expect(!first, "the replaced hold's ending isn't called")
        #expect(second && revealed)
    }
}
