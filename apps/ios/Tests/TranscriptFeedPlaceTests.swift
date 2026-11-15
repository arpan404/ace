import CoreGraphics
import Testing
@testable import Ace

/// A focused open landing through the feed's own event routing: every event goes through
/// `TranscriptFeedPlace` as the feed sends it, and an aim is performed the way SwiftUI performs
/// it, by moving the content, whose only report is its new origin.
@Suite struct TranscriptFeedPlaceTests {
    private struct Feed {
        var keeper = TranscriptPlaceKeeper()
        var landing = TranscriptFocusLanding()
        var held: TranscriptHeldAnchor?
        var corrections: [TranscriptFeedPlace.Action] = []
        var aims = 0
        var released = 0
        var now = 0.0
        /// Which row shows each item.
        var showing: [String: String] = [:]
        /// An 800-point feed with no header, the composer and keyboard over its bottom 200.
        let geometry = TranscriptFocusLanding.Geometry(viewport: 800, topInset: 0, bottomInset: 0, covered: 200)

        init(rows: [String]) {
            for (index, id) in rows.enumerated() {
                showing["item.\(id)"] = id
                layOut(id, y: CGFloat(index) * 100)
            }
        }
        func top(_ id: String) -> Double? { keeper.frames.top(id, inset: 0) }

        mutating func layOut(_ id: String, y: CGFloat, height: CGFloat = 100) {
            send(.keeper(.laidOut(id, CGRect(x: 0, y: y, width: 320, height: height))))
        }
        mutating func send(_ event: TranscriptFeedPlace.Event) {
            let showing = showing
            let facts = TranscriptFeedPlace.Facts(
                keeper: TranscriptPlaceKeeper.Facts(held: held, inset: 0, mayCapture: true, mayCorrect: true),
                geometry: geometry, rowShowing: { showing[$0] })
            for action in TranscriptFeedPlace.next(event, keeper: &keeper, landing: &landing, facts: facts, now: now) {
                switch action {
                case .hold(let id, let top): held = TranscriptHeldAnchor(rowID: id, itemID: nil, top: top)
                case .place: corrections.append(action)
                case .aim(let id, let anchor):
                    aims += 1
                    scroll(to: id, anchor: anchor)
                case .released: released += 1
                }
            }
        }
        /// What `proxy.scrollTo(id, anchor:)` does: the same fraction of the row and the feed line
        /// up (the middle when no anchor is given). A row not drawn yet moves nothing.
        private mutating func scroll(to id: String, anchor: Double?) {
            guard let frame = keeper.frames.frame(id) else { return }
            let target = (anchor ?? 0.5) * (geometry.viewport - Double(frame.height))
            send(.keeper(.origin(keeper.frames.origin + CGFloat(target) - frame.minY)))
        }
        mutating func open(_ item: String) {
            landing.jumped(to: item, now: now)
            landing.replied(focus: item, now: now)
        }
    }

    @Test func aFocusBroughtIntoViewByScrollingAloneIsHeldAndSaved() {
        // Every row is drawn, so the aim moves only the content's origin: no row lays out again
        // and no revision comes, yet the landing completes and its row becomes the saved place.
        var feed = Feed(rows: ["a", "b", "c", "d", "e", "f"])
        feed.open("item.f")
        feed.send(.revised)
        #expect(feed.aims == 1)
        #expect(!feed.landing.holdsPlace)
        #expect(feed.released == 1, "paging and the end's reads may run again")
        #expect(feed.held == TranscriptHeldAnchor(rowID: "f", itemID: nil, top: 250))
        #expect(feed.top("f") == 250)
    }

    @Test func aFocusRowDrawnLateLandsWhenItLaysOutAndIsPutBackAfterwards() {
        // The window's rows land before the focus row is drawn; it is drawn far below, at an
        // estimate, and rows above it size themselves after it was shown.
        var feed = Feed(rows: ["a", "b", "c"])
        feed.landing.jumped(to: "item.f", now: 0)
        feed.send(.revised)
        #expect(feed.aims == 0, "no row to aim at before the reply and rows arrive")
        feed.landing.replied(focus: "item.f", now: 100)
        feed.send(.targetNamed)
        feed.showing["item.f"] = "f"
        feed.layOut("f", y: 2_000)
        #expect(!feed.landing.holdsPlace)
        #expect(feed.held == TranscriptHeldAnchor(rowID: "f", itemID: nil, top: 250))
        feed.layOut("c", y: 200, height: 180)
        feed.layOut("f", y: 2_080)
        #expect(feed.corrections == [.place(rowID: "f", top: 250)])
    }

    @Test func whileAFocusLandsTheRowHeldBeforeItIsNotPutBack() {
        var feed = Feed(rows: ["a", "b", "c"])
        feed.held = TranscriptHeldAnchor(rowID: "b", itemID: nil, top: 100)
        feed.landing.jumped(to: "item.f", now: 0)
        feed.layOut("a", y: 0, height: 160)
        feed.layOut("b", y: 160)
        feed.send(.keeper(.phase(.idle)))
        #expect(feed.corrections.isEmpty)
        #expect(feed.held?.rowID == "b")
    }

    @Test func theDeadlineLetsGoOfAFocusWhoseRowNeverArrives() {
        var feed = Feed(rows: ["a", "b", "c"])
        feed.open("item.f")
        feed.send(.revised)
        feed.now = TranscriptFocusLanding.landLimit - 1
        feed.send(.deadline)
        #expect(feed.landing.holdsPlace, "a tick before the deadline changes nothing")
        #expect(feed.released == 0)
        feed.now = TranscriptFocusLanding.landLimit
        feed.send(.deadline)
        #expect(!feed.landing.holdsPlace)
        #expect(feed.released == 1)
    }

    @Test func aTakeoverBeforeTheReplyLeavesTheReaderWhereTheyAre() {
        var feed = Feed(rows: ["a", "b", "c", "d", "e", "f"])
        feed.landing.jumped(to: "item.f", now: 0)
        feed.send(.takeover)
        feed.landing.replied(focus: "item.f", now: 100)
        feed.send(.targetNamed)
        feed.send(.revised)
        #expect(feed.aims == 0)
        #expect(!feed.landing.isActive)
    }

    @Test func aDragAfterTheFocusLandedHoldsWhereTheReaderStops() {
        var feed = Feed(rows: ["a", "b", "c", "d", "e", "f"])
        feed.open("item.f")
        feed.send(.revised)
        #expect(feed.held?.rowID == "f")
        feed.send(.takeover)
        feed.send(.keeper(.phase(.gesture)))
        // Back up the thread until c is the top row.
        feed.send(.keeper(.origin(-200)))
        feed.send(.keeper(.phase(.idle)))
        #expect(feed.held == TranscriptHeldAnchor(rowID: "c", itemID: nil, top: 0))
    }

    @Test func scrollingWithNoFocusLandingLeavesTheLandingUntouched() {
        // The feed writes the landing back only when it changed: a plain scroll must not.
        var feed = Feed(rows: ["a", "b", "c"])
        for step in 1...50 { feed.send(.keeper(.origin(CGFloat(-step)))) }
        feed.send(.keeper(.phase(.idle)))
        #expect(feed.landing == TranscriptFocusLanding())
        #expect(feed.aims == 0)
    }
}
