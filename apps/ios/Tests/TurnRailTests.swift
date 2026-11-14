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
        #expect(TurnRail.shows(turns: 4, behind: true, scrubbing: false))
        #expect(!TurnRail.shows(turns: 3, behind: true, scrubbing: false))
        #expect(!TurnRail.shows(turns: 40, behind: false, scrubbing: false))
        #expect(TurnRail.shows(turns: 40, behind: false, scrubbing: true))
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
    @Test func aTurnWithoutALogIsCountedFromTheNextOne() {
        // Turn 4 answered without steps; turn 5 has a log.
        let rows: [TurnRail.Mark] = [.ask, .answer, .ask, .head(5), .answer]
        #expect(TurnRail.readerPlace(rows, top: 0)?.ordinal(of: 5) == 4)
        #expect(TurnRail.readerPlace([], top: 0) == nil)
    }
}
