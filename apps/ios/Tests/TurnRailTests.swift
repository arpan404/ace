import Foundation
import Observation
import Synchronization
import Testing
@testable import Ace

@Suite struct TurnRailTests {
    @Test func aShortThreadShowsEveryTurn() {
        #expect(TurnRail.ordinals(count: 5, current: 2, limit: 40) == [1, 2, 3, 4, 5])
    }
    @Test func aLongThreadSpreadsTicksEvenlyAndKeepsTheTurnsInView() {
        let ticks = TurnRail.ordinals(count: 1_000, current: 437, limit: 20, last: 439)
        #expect(ticks.count <= 20)
        #expect(ticks.first == 1)
        #expect(ticks.last == 1_000)
        #expect([437, 438, 439].allSatisfy(ticks.contains))
        #expect(ticks == ticks.sorted())
    }
    @Test func neverMoreTicksThanTheRailHolds() {
        #expect(TurnRail.ordinals(count: 10_000, current: 1, limit: 500).count <= 79)
        #expect(TurnRail.ordinals(count: 0, current: 1).isEmpty)
    }
    @Test func aTouchPicksTheNearestTick() {
        let ticks = [1, 10, 20, 30]
        #expect(TurnRail.tick(at: 0, height: 300, ticks: ticks) == 1)
        #expect(TurnRail.tick(at: 140, height: 300, ticks: ticks) == 10)
        #expect(TurnRail.tick(at: 160, height: 300, ticks: ticks) == 20)
        #expect(TurnRail.tick(at: 900, height: 300, ticks: ticks) == 30)
        #expect(TurnRail.tick(at: -40, height: 300, ticks: ticks) == 1)
    }
    @Test func theRailShowsFromFourTurnsWhileReadingAwayFromTheEnd() {
        #expect(TurnRail.shows(turns: 4, behind: true, keyboardUp: false, scrubbing: false))
        #expect(!TurnRail.shows(turns: 3, behind: true, keyboardUp: false, scrubbing: false))
        #expect(!TurnRail.shows(turns: 40, behind: false, keyboardUp: false, scrubbing: false))
        #expect(TurnRail.shows(turns: 40, behind: false, keyboardUp: false, scrubbing: true))
    }
    @Test func theKeyboardHidesTheRailWithoutLeavingHistory() {
        #expect(!TurnRail.shows(turns: 40, behind: true, keyboardUp: true, scrubbing: false))
    }
    @Test func aJumpedTurnIsMarkedUntilTheReaderScrollsOn() {
        var selection = TurnRail.Selection()
        // Reading turn 7, the person jumps to turn 2: it is marked at once.
        selection.pick(2)
        #expect(selection.current(scrub: nil, place: .turn(7), count: 9) == 2)
        // The jump lands on turn 2, then an ordinary scroll settles on turn 5: the rail follows it.
        selection.readerMoved()
        #expect(selection.current(scrub: nil, place: .turn(5), count: 9) == 5)
        #expect(selection.current(scrub: nil, place: .beforeNewest(0), count: 9) == 9)
    }
    @Test func theFingerOutranksAPickedTurn() {
        var selection = TurnRail.Selection()
        selection.pick(2)
        #expect(selection.current(scrub: 6, place: .turn(7), count: 9) == 6)
        // Nothing is marked past the thread's ends.
        #expect(TurnRail.Selection().current(scrub: nil, place: .turn(12), count: 9) == 9)
        #expect(TurnRail.Selection().current(scrub: nil, place: nil, count: 0) == 1)
    }
    @Test func aTapOnTheBandJumpsWhereItTouched() {
        let start = Date(timeIntervalSinceReferenceDate: 0)
        var touch = TurnRail.BandTouch(start: start, y: 2)
        touch.moved(to: 4, at: start.addingTimeInterval(0.05))
        #expect(!touch.scrubbing)
        #expect(touch.lifted(at: 4) == 2)
    }
    @Test func holdingThenDraggingScrubsAndLiftingJumpsWhereTheFingerIs() {
        let start = Date(timeIntervalSinceReferenceDate: 0)
        var touch = TurnRail.BandTouch(start: start, y: 300)
        touch.moved(to: 302, at: start.addingTimeInterval(0.25))
        #expect(touch.scrubbing)
        touch.moved(to: 10, at: start.addingTimeInterval(0.6))
        #expect(touch.scrubbing)
        #expect(touch.lifted(at: 10) == 10)
    }
    @Test func aQuickSwipeOnTheBandNeitherScrubsNorJumps() {
        let start = Date(timeIntervalSinceReferenceDate: 0)
        var touch = TurnRail.BandTouch(start: start, y: 300)
        touch.moved(to: 200, at: start.addingTimeInterval(0.08))
        // Once it was a swipe, holding still afterwards changes nothing.
        touch.moved(to: 200, at: start.addingTimeInterval(0.5))
        #expect(!touch.scrubbing)
        #expect(touch.lifted(at: 200) == nil)
    }
    @Test func aHeldTouchLiftedWithoutMovingJumpsWhereItRested() {
        let start = Date(timeIntervalSinceReferenceDate: 0)
        var touch = TurnRail.BandTouch(start: start, y: 120)
        touch.moved(to: 121, at: start.addingTimeInterval(0.4))
        #expect(touch.lifted(at: 121) == 121)
    }
    @Test func theReadersTurnIsTheOneTheTopRowBelongsTo() {
        let rows: [TurnRail.Mark] = [.ask, .head(7), .answer, .ask, .head(8), .answer, .ask, .answer]
        // On turn 7's ask, its log and its answer.
        #expect(TurnRail.readerPlace(rows, top: 0)?.ordinal(of: 9) == 7)
        #expect(TurnRail.readerPlace(rows, top: 2)?.ordinal(of: 9) == 7)
        // Turn 8 from its ask on.
        #expect(TurnRail.readerPlace(rows, top: 3)?.ordinal(of: 9) == 8)
        // The running turn has no settled log yet: it is the newest.
        #expect(TurnRail.readerPlace(rows, top: 6)?.ordinal(of: 9) == 9)
        #expect(TurnRail.readerPlace(rows, top: 7)?.ordinal(of: 9) == 9)
    }
    @Test func aHeldTurnIsFoundByItsAsk() {
        let rows: [TurnRail.Mark] = [.answer, .ask, .head(7), .answer, .ask, .head(8), .answer, .ask, .answer]
        #expect(TurnRail.askIndex(of: 7, in: rows, count: 9) == 1)
        #expect(TurnRail.askIndex(of: 8, in: rows, count: 9) == 4)
        // The running turn's ask, after the last settled log.
        #expect(TurnRail.askIndex(of: 9, in: rows, count: 9) == 7)
        // A turn outside the rows held has to be read in.
        #expect(TurnRail.askIndex(of: 3, in: rows, count: 9) == nil)
    }
    @Test func aTurnWithoutALogIsCountedFromTheNextOne() {
        // Turn 4 answered without steps; turn 5 has a log.
        let rows: [TurnRail.Mark] = [.ask, .answer, .ask, .head(5), .answer]
        #expect(TurnRail.readerPlace(rows, top: 0)?.ordinal(of: 5) == 4)
        #expect(TurnRail.readerPlace([], top: 0) == nil)
    }
}

/// The feed hands the rail where the reader is each time a scroll settles. Only a real change may
/// reach the rail: a write of the same value would re-render it on every settle.
@MainActor @Suite struct TurnRailPlaceTests {
    /// Whether reading `read` from `place` is told of a change made by `change`.
    private func notifies(_ place: TurnRailPlace, read: @escaping () -> Void, change: () -> Void) -> Bool {
        let told = Mutex(false)
        withObservationTracking(read) { told.withLock { $0 = true } }
        change()
        return told.withLock { $0 }
    }
    @Test func settlingWhereTheReaderAlreadyIsTellsTheRailNothing() {
        let place = TurnRailPlace()
        place.settle(.turn(3))
        #expect(!notifies(place, read: { _ = place.place }, change: { place.settle(.turn(3)) }))
        #expect(notifies(place, read: { _ = place.place }, change: { place.settle(.turn(4)) }))
        #expect(place.place == .turn(4))
    }
    @Test func eachTurnPickedReachesTheFeedOnceEvenTheSameTurnAgain() {
        let place = TurnRailPlace()
        place.ask(turn: 2, count: 9)
        let first = place.request
        #expect(first?.turn == 2 && first?.count == 9)
        #expect(notifies(place, read: { _ = place.request }, change: { place.ask(turn: 2, count: 9) }))
        #expect(place.request != first)
    }
    @Test func theKeyboardReachesTheRailOnlyWhenItRisesOrFalls() {
        let place = TurnRailPlace()
        #expect(!notifies(place, read: { _ = place.keyboardUp }, change: { place.keyboard(up: false) }))
        #expect(notifies(place, read: { _ = place.keyboardUp }, change: { place.keyboard(up: true) }))
        #expect(place.keyboardUp)
    }
}
