import Testing
@testable import Ace

@Suite struct NeedsRunQueueTests {
    private func entry(_ machine: String, _ thread: String, _ request: String) -> NeedsRunQueue.Entry {
        .init(thread: InboxKey(machineId: machine, id: thread), request: request)
    }

    @Test func aRequestArrivingDuringTheRunJoinsAtTheEndWithoutMovingThePageOnScreen() {
        let push = entry("mac", "queue", "push"), plan = entry("mac", "notes", "plan")
        var run = NeedsRunQueue([push, plan])
        run.next { _ in true }
        let late = entry("studio", "fleet", "tests")
        // The live list can put the newcomer anywhere; the run keeps its pages and appends it.
        run.merge([late, push, plan])
        #expect(run.current == plan)
        #expect(run.pages == [push, plan, late])
    }

    @Test func movingOnPassesRequestsAnsweredElsewhereMeanwhile() {
        let a = entry("mac", "a", "1"), b = entry("mac", "b", "2"), c = entry("mac", "c", "3")
        var run = NeedsRunQueue([a, b, c])
        run.next { $0 != b }
        #expect(run.current == c)
    }

    @Test func thePageOnScreenClosingElsewhereMovesToTheNextOpenOne() {
        let a = entry("mac", "a", "1"), b = entry("mac", "b", "2")
        var run = NeedsRunQueue([a, b])
        run.skipClosed { $0 != a }
        #expect(run.current == b)
        // A page still open stays put.
        run.skipClosed { _ in true }
        #expect(run.current == b)
    }

    @Test func theRunEndsAfterItsLastPageWithFullProgress() {
        var run = NeedsRunQueue([entry("mac", "a", "1")])
        #expect(run.progress == 0)
        run.next { _ in true }
        #expect(run.atEnd)
        #expect(run.current == nil)
        #expect(run.progress == 1)
    }

    @Test func theEndNeverSaysNothingWaitsWhileARequestIsOpenOrAnAnswerIsTravelling() {
        #expect(NeedsRunQueue.end(waiting: 2, sending: 1) == .remaining(2))
        #expect(NeedsRunQueue.end(waiting: 0, sending: 1) == .sending(1))
        #expect(NeedsRunQueue.end(waiting: 0, sending: 0) == .nothing)
    }

    @Test func goingThroughAgainStartsFromWhatStillWaits() {
        let a = entry("mac", "a", "1"), b = entry("mac", "b", "2")
        var run = NeedsRunQueue([a, b])
        run.next { _ in true }
        run.next { _ in true }
        run.again([b])
        #expect(run.current == b)
        #expect(run.pages == [b])
    }

    @Test func aRequestAnsweredHereStopsWaitingButStillCountsUntilItsMachineClosesIt() {
        let push = entry("mac", "queue", "push")
        let facts = NeedsRunQueue.Facts(needsYou: true, requests: ["push"], answering: ["push"])
        #expect(!NeedsRunQueue.isOpen(push, facts))
        #expect(NeedsRunQueue.isOpen(push, .init(needsYou: true, requests: ["push"], answering: [])))
        #expect(!NeedsRunQueue.isOpen(push, .init(needsYou: false, requests: [], answering: [])))
    }

    @Test func aThreadThatNeedsThePersonWithNothingToAnswerHereKeepsItsPageUntilTheDaemonSaysOtherwise() {
        let unsent = NeedsRunQueue.Entry(thread: InboxKey(machineId: "mac", id: "held"), request: nil)
        #expect(NeedsRunQueue.isOpen(unsent, .init(needsYou: true, requests: [], answering: [])))
        #expect(!NeedsRunQueue.isOpen(unsent, .init(needsYou: false, requests: [], answering: [])))
        // Its requests read later get pages of their own; the thread page steps aside.
        #expect(!NeedsRunQueue.isOpen(unsent, .init(needsYou: true, requests: ["ask"], answering: [])))
    }
}
