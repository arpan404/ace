import CoreGraphics
import Testing
@testable import Ace

/// Where the feed holds the reader, whatever order SwiftUI reports the scroll, the rows and the
/// scroll phase in. Each test drives a feed of 100-point rows through the machine the way the
/// feed does: the place it holds is the anchor it saves, and a correction moves the content.
@Suite struct TranscriptPlaceKeeperTests {
    /// The feed around the machine: the held anchor it records and the corrections it scrolls.
    private struct Feed {
        var keeper = TranscriptPlaceKeeper()
        var held: TranscriptHeldAnchor?
        var corrections: [TranscriptPlaceKeeper.Action] = []
        var mayCapture = true
        var mayCorrect = true
        var now = 0.0
        /// A focused open's landing, consulted the way the feed consults it.
        var landing = TranscriptFocusLanding()
        /// An 800-point feed with no header, the composer and keyboard over its bottom 200.
        let geometry = TranscriptFocusLanding.Geometry(viewport: 800, topInset: 0, bottomInset: 0, covered: 200)

        init(rows: [String], origin: CGFloat = 0) {
            for (index, id) in rows.enumerated() { layOut(id, y: CGFloat(index) * 100) }
            send(.origin(origin))
        }
        /// What a reopened feed restores: the anchor it holds.
        var saved: TranscriptHeldAnchor? { held }
        func top(_ id: String) -> Double? { keeper.frames.top(id, inset: 0) }

        mutating func layOut(_ id: String, y: CGFloat, height: CGFloat = 100) {
            send(.laidOut(id, CGRect(x: 0, y: y, width: 320, height: height)))
        }
        mutating func send(_ event: TranscriptPlaceKeeper.Event) {
            let facts = TranscriptPlaceKeeper.Facts(held: held, inset: 0, focusLanding: landing.holdsPlace,
                                                    mayCapture: mayCapture, mayCorrect: mayCorrect)
            for action in keeper.next(event, facts: facts, now: now) {
                switch action {
                case .hold(let id, let top): held = TranscriptHeldAnchor(rowID: id, itemID: nil, top: top)
                case .place: corrections.append(action)
                }
            }
        }
        /// The feed's `landFocus`: the landing's next step for `row` (nil until it is among the
        /// rows), its scroll performed at once, and a landed row handed to the keeper.
        @discardableResult
        mutating func landFocus(_ row: String?) -> TranscriptFocusLanding.Step {
            let frame = row.flatMap { keeper.frames.frame($0) }.map { TranscriptFocusLanding.Span(top: Double($0.minY), bottom: Double($0.maxY)) }
            let step = landing.step(row: row, frame: frame, in: geometry, now: now)
            switch step {
            case .scroll(let id, let anchor?):
                // Same fraction of the row and of the feed line up.
                guard let frame = keeper.frames.frame(id) else { break }
                let target = anchor * (geometry.viewport - Double(frame.height))
                send(.origin(keeper.frames.origin + CGFloat(target) - frame.minY))
            case .landed(let id): send(.focusLanded(id))
            case .scroll, .wait, .none: break
            }
            return step
        }
        /// The scroll a correction asked for lands: the row sits at the top it was put at.
        mutating func land(_ action: TranscriptPlaceKeeper.Action) {
            guard case .place(let id, let top) = action, let now = self.top(id) else { return }
            send(.origin(keeper.frames.origin + CGFloat(top - now)))
        }
    }

    @Test func aResizeAfterADragIsPutBackWhereTheDragLeftTheReader() {
        var feed = Feed(rows: ["a", "b", "c", "d"])
        feed.send(.phase(.gesture))
        feed.send(.origin(-150))
        feed.send(.phase(.idle))
        #expect(feed.held == TranscriptHeldAnchor(rowID: "b", itemID: nil, top: -50))
        // No content frame changed with the drag. Then a, above, grows by 60: b's callback comes
        // before c's, and before any origin report.
        feed.layOut("a", y: 0, height: 160)
        feed.layOut("b", y: 160)
        feed.layOut("c", y: 260)
        #expect(feed.corrections == [.place(rowID: "b", top: -50)])
        feed.land(feed.corrections[0])
        #expect(feed.top("b") == -50)
        #expect(feed.saved == TranscriptHeldAnchor(rowID: "b", itemID: nil, top: -50))
        #expect(feed.corrections.count == 1)
    }

    @Test func aCorrectionOwedDuringAnAnimationRunsOnceTheAnimationEnds() {
        var feed = Feed(rows: ["a", "b", "c"])
        feed.held = TranscriptHeldAnchor(rowID: "b", itemID: nil, top: 100)
        feed.send(.phase(.animating))
        feed.layOut("a", y: 0, height: 140)
        feed.layOut("b", y: 140)
        // The animation's own origin reports arrive while it runs: nothing may scroll yet, and
        // the correction stays owed.
        feed.send(.origin(-5))
        feed.send(.origin(-10))
        #expect(feed.corrections.isEmpty)
        feed.send(.phase(.idle))
        #expect(feed.corrections == [.place(rowID: "b", top: 100)])
    }

    @Test func aCorrectionOwedDuringAnAnimationThatNeverEndsRunsAfterTheFallback() {
        var feed = Feed(rows: ["a", "b", "c"])
        feed.held = TranscriptHeldAnchor(rowID: "b", itemID: nil, top: 100)
        feed.send(.phase(.animating))
        feed.layOut("a", y: 0, height: 140)
        feed.layOut("b", y: 140)
        feed.now = TranscriptPlaceKeeper.animationLimit / 2
        feed.send(.tick)
        #expect(feed.corrections.isEmpty)
        feed.now = TranscriptPlaceKeeper.animationLimit
        feed.send(.tick)
        #expect(feed.corrections == [.place(rowID: "b", top: 100)])
    }

    @Test func aRowAppearingAfterADragLetsTheFinalOriginRefreshThePlace() {
        var feed = Feed(rows: ["a", "b", "c", "d"])
        feed.send(.phase(.gesture))
        feed.send(.origin(-140))
        // Idle arrives on the second-to-last origin, then a row below appears, then the last one.
        feed.send(.phase(.idle))
        #expect(feed.held == TranscriptHeldAnchor(rowID: "b", itemID: nil, top: -40))
        feed.layOut("e", y: 400)
        feed.send(.origin(-210))
        #expect(feed.held == TranscriptHeldAnchor(rowID: "c", itemID: nil, top: -10))
        // A later resize above c is corrected to where the reader really stopped.
        feed.layOut("b", y: 100, height: 130)
        feed.layOut("c", y: 230)
        #expect(feed.corrections == [.place(rowID: "c", top: -10)])
        #expect(feed.saved == TranscriptHeldAnchor(rowID: "c", itemID: nil, top: -10))
    }

    @Test func aTurnJumpHoldsTheTurnItAskedForEvenWhenIdleComesBeforeTheLastOrigin() {
        var feed = Feed(rows: ["answer", "ask", "log"])
        feed.send(.jumped("ask"))
        #expect(feed.held?.rowID == "ask")
        feed.send(.phase(.animating))
        feed.send(.origin(-60))
        // Idle with the ask still 40 points down and the previous answer partly showing.
        feed.send(.phase(.idle))
        #expect(feed.held == TranscriptHeldAnchor(rowID: "ask", itemID: nil, top: 40))
        feed.send(.origin(-100))
        #expect(feed.saved == TranscriptHeldAnchor(rowID: "ask", itemID: nil, top: 0))
        // A resize above it after landing puts the ask back, not the answer.
        feed.layOut("answer", y: 0, height: 150)
        feed.layOut("ask", y: 150)
        #expect(feed.corrections == [.place(rowID: "ask", top: 0)])
    }

    @Test func aScrollAfterAJumpLandedIsNotTheJumps() {
        var feed = Feed(rows: ["a", "b", "c"])
        feed.send(.jumped("b"))
        feed.send(.phase(.animating))
        feed.send(.origin(-100))
        feed.send(.phase(.idle))
        // The status bar's scroll to the top, later: the jump's turn stays the one held.
        feed.send(.phase(.animating))
        feed.send(.origin(0))
        feed.send(.phase(.idle))
        #expect(feed.held == TranscriptHeldAnchor(rowID: "b", itemID: nil, top: 0))
    }

    @Test func aJumpStopsFollowingItsTurnOnceAnotherRowIsHeld() {
        var feed = Feed(rows: ["a", "b", "c"])
        feed.send(.jumped("b"))
        feed.send(.phase(.animating))
        feed.send(.origin(-100))
        // A disclosure opened in c holds c while the jump lands.
        feed.held = TranscriptHeldAnchor(rowID: "c", itemID: nil, top: 100)
        feed.send(.phase(.idle))
        feed.send(.origin(-90))
        #expect(feed.held == TranscriptHeldAnchor(rowID: "c", itemID: nil, top: 100))
    }

    @Test func aGestureDropsACorrectionStillOwed() {
        var feed = Feed(rows: ["a", "b", "c"])
        feed.held = TranscriptHeldAnchor(rowID: "b", itemID: nil, top: 100)
        feed.mayCapture = false
        feed.send(.phase(.animating))
        feed.layOut("a", y: 0, height: 140)
        feed.layOut("b", y: 140)
        feed.send(.phase(.gesture))
        feed.send(.phase(.idle))
        #expect(feed.corrections.isEmpty)
    }

    @Test func nothingIsHeldOrPutBackWhenTheFeedMayNot() {
        var feed = Feed(rows: ["a", "b", "c"])
        feed.mayCapture = false
        feed.mayCorrect = false
        feed.send(.phase(.gesture))
        feed.send(.origin(-50))
        feed.send(.phase(.idle))
        #expect(feed.held == nil)
        feed.held = TranscriptHeldAnchor(rowID: "b", itemID: nil, top: 50)
        feed.layOut("a", y: 0, height: 140)
        feed.layOut("b", y: 140)
        #expect(feed.corrections.isEmpty)
    }

    @Test func scrollingWithNothingHeldOrOwedAsksForNothing() {
        var feed = Feed(rows: ["a", "b", "c"])
        feed.mayCapture = false
        for step in 1...50 { feed.send(.origin(CGFloat(-step))) }
        #expect(feed.held == nil)
        #expect(feed.corrections.isEmpty)
    }

    @Test func aFocusLandingKeepsThePlaceFromTheRowHeldBeforeIt() {
        // Reading row b, then a focused open: rows growing above b must not pull the reader back
        // to b while the focus is on its way.
        var feed = Feed(rows: ["a", "b", "c"])
        feed.held = TranscriptHeldAnchor(rowID: "b", itemID: nil, top: 100)
        feed.landing.jumped(to: "item.f", now: 0)
        feed.layOut("a", y: 0, height: 160)
        feed.layOut("b", y: 160)
        feed.send(.phase(.idle))
        #expect(feed.corrections.isEmpty)
    }

    @Test func aFocusedOpenLandsOnItsRowWhateverOrderItsRowsAndReplyArriveIn() {
        // The window's rows land before the reply, the focus row is drawn last and off screen,
        // and rows above it grow after it was shown.
        var feed = Feed(rows: ["a", "b", "c"])
        feed.landing.jumped(to: "item.f", now: 0)
        #expect(feed.landFocus(nil) == .wait)
        feed.landing.replied(focus: "item.f", now: 100)
        for (index, id) in ["d", "e"].enumerated() { feed.layOut(id, y: CGFloat(300 + index * 100)) }
        #expect(feed.landFocus("f") == .scroll(rowID: "f", anchor: nil))
        // Lazy rows above drew at an estimate: the row appears far below the screen.
        feed.layOut("f", y: 2_000)
        guard case .scroll = feed.landFocus("f") else { Issue.record("a row off screen is placed again"); return }
        #expect(feed.landFocus("f") == .landed(rowID: "f"))
        // Held where it landed: centred in the 600 points above the composer and keyboard.
        #expect(feed.held == TranscriptHeldAnchor(rowID: "f", itemID: nil, top: 250))
        #expect(!feed.landing.holdsPlace)
        // Markdown above sizes itself afterwards: the focus is put back, not left to drift.
        feed.layOut("e", y: 400, height: 180)
        feed.layOut("f", y: 2_080)
        #expect(feed.corrections == [.place(rowID: "f", top: 250)])
    }

    @Test func theReaderDraggingAwayFromALandedFocusHoldsWhereTheyStop() {
        var feed = Feed(rows: ["a", "b", "c", "f"])
        feed.landing.jumped(to: "item.f", now: 0)
        feed.landing.replied(focus: "item.f", now: 100)
        while case .scroll = feed.landFocus("f") {}
        #expect(feed.held?.rowID == "f")
        feed.send(.phase(.gesture))
        feed.send(.origin(-150))
        feed.send(.phase(.idle))
        #expect(feed.held == TranscriptHeldAnchor(rowID: "b", itemID: nil, top: -50))
    }
}
