import Foundation
import Testing
@testable import Ace

/// A card sent from the phone stays locked wherever it is drawn until Spade's update settles it.
@Suite @MainActor struct SpadeCardsTests {
    static func card(_ standing: SpadeQuestionCard.Standing, closed: Bool = false) -> SpadeQuestionCard {
        SpadeQuestionCard(callId: "q1", label: "Planner asks: Go?", standing: standing, questions: [], answers: nil, line: nil,
                          closed: closed)
    }
    static let read: () async -> SpadeOutcome = { SpadeOutcome(ok: true) }
    private func card(_ standing: SpadeQuestionCard.Standing) -> SpadeModel.Bubble {
        .question(SpadeCardsTests.card(standing))
    }

    @Test func aSentCardStaysLockedThroughLeavingAndReopeningUntilItSettles() async {
        let spade = SpadeModel()
        spade.apply(.row(conversation: "c1", key: "k", bubble: card(.open)))
        var posts = 0
        let outcome = await spade.cards.send("c1", callId: "q1", readBack: SpadeCardsTests.read) { posts += 1; return SpadeOutcome(ok: true) }
        #expect(outcome.ok)
        #expect(spade.cards.isSending("c1", callId: "q1"))

        // Another conversation, then back: the card is drawn again, still open, still locked.
        spade.apply(.row(conversation: "c2", key: "k", bubble: card(.open)))
        spade.apply(.row(conversation: "c1", key: "k", bubble: card(.open)))
        #expect(spade.cards.isSending("c1", callId: "q1"))
        _ = await spade.cards.send("c1", callId: "q1", readBack: SpadeCardsTests.read) { posts += 1; return SpadeOutcome(ok: true) }
        #expect(posts == 1)
        // The same call in another conversation is another card.
        #expect(!spade.cards.isSending("c2", callId: "q1"))

        spade.apply(.row(conversation: "c1", key: "k", bubble: card(.settled)))
        #expect(!spade.cards.isSending("c1", callId: "q1"))
    }

    @Test func aRefusedCardUnlocksAtOnce() async {
        let spade = SpadeModel()
        spade.apply(.row(conversation: "c1", key: "k", bubble: card(.open)))
        let outcome = await spade.cards.send("c1", callId: "q1", readBack: SpadeCardsTests.read) { SpadeOutcome(ok: false, message: "At most 14.") }
        #expect(!outcome.ok)
        #expect(!spade.cards.isSending("c1", callId: "q1"))
    }

    @Test func anOlderRefusalLeavesANewerSendLocked() async {
        let cards = SpadeCards()
        cards.saw(SpadeCardsTests.card(.open), in: "c1")
        let older = Gate()
        let first = Task { await cards.send("c1", callId: "q1", readBack: SpadeCardsTests.read) { await older.wait(); return SpadeOutcome(ok: false, message: "Not open.") } }
        while !cards.isSending("c1", callId: "q1") { await Task.yield() }
        // Spade moves the card on (another device left it for later), and it is sent again.
        cards.saw(SpadeCardsTests.card(.later), in: "c1")
        #expect(await cards.send("c1", callId: "q1", readBack: SpadeCardsTests.read) { SpadeOutcome(ok: true) }.ok)

        older.open()
        #expect(await !first.value.ok)
        #expect(cards.isSending("c1", callId: "q1"))
    }

    @Test func whatWasFilledInStaysWithTheCardThroughAnswerLaterUntilItSettles() {
        let cards = SpadeCards()
        cards.saw(SpadeCardsTests.card(.open), in: "c1")
        let filled: [SpadeQuestionCard.Draft] = [.picks(["Porto"], other: ""), .number("", language: nil)]
        cards.keep(filled, conversation: "c1", callId: "q1")

        // Left for later, folded, and opened again: the same drafts.
        cards.saw(SpadeCardsTests.card(.later), in: "c1")
        cards.saw(SpadeCardsTests.card(.later), in: "c1")
        #expect(cards.drafts("c1", callId: "q1") == filled)
        #expect(cards.drafts("c2", callId: "q1") == nil)

        cards.saw(SpadeCardsTests.card(.settled), in: "c1")
        #expect(cards.drafts("c1", callId: "q1") == nil)
    }

    @Test func aCardClosedOnlyBecauseItsReplyFinishedKeepsItsDraftAndLock() async {
        let clock = ManualClock()
        let cards = SpadeCards(wait: { await clock.sleep($0) })
        cards.saw(SpadeCardsTests.card(.open), in: "c1")
        let filled: [SpadeQuestionCard.Draft] = [.text("Faro")]
        cards.keep(filled, conversation: "c1", callId: "q1")
        _ = await cards.send("c1", callId: "q1", readBack: SpadeCardsTests.read) { SpadeOutcome(ok: true) }

        // The reply ended with the card unanswered: it may have been left for later meanwhile.
        cards.saw(SpadeCardsTests.card(.settled, closed: true), in: "c1")
        #expect(cards.drafts("c1", callId: "q1") == filled)
        #expect(cards.isSending("c1", callId: "q1"))

        // Its own status settles it.
        cards.saw(SpadeCardsTests.card(.settled), in: "c1")
        #expect(cards.drafts("c1", callId: "q1") == nil)
        #expect(!cards.isSending("c1", callId: "q1"))
        clock.advance()
    }

    @Test func anotherRouteToTheSameMachineKeepsCardsForLaterButAnotherMachineDoesNot() async throws {
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in QuietSession() })
        func reach(_ host: String, at port: Int) async throws {
            let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:\(port)")), hostId: host,
                                          deviceId: "device", pin: nil, credential: { "{}" })
            await model.connect(target: target, directory: FileManager.default.temporaryDirectory)
        }
        try await reach("home", at: 1)
        model.spade.apply(.row(conversation: "c1", key: "k", bubble: .question(SpadeCardsTests.card(.later))))
        model.spade.cards.keep([.text("Faro")], conversation: "c1", callId: "q1")

        // Wi-Fi to cellular: the same machine by another route.
        try await reach("home", at: 2)
        #expect(model.spade.cards.drafts("c1", callId: "q1") == [.text("Faro")])

        try await reach("work", at: 1)
        #expect(model.spade.cards.drafts("c1", callId: "q1") == nil)
    }

    @Test func anAcceptedCardWhoseUpdateNeverComesIsReadBackAndUnlocked() async {
        let clock = ManualClock()
        let cards = SpadeCards(wait: { await clock.sleep($0) })
        cards.saw(SpadeCardsTests.card(.open), in: "c1")
        let reads = Count()
        #expect(await cards.send("c1", callId: "q1", readBack: { reads.add(); return SpadeOutcome(ok: true) }) { SpadeOutcome(ok: true) }.ok)
        await clock.untilWaiting()
        #expect(clock.asked == [.seconds(10)])
        #expect(cards.isSending("c1", callId: "q1"))
        #expect(reads.value == 0)

        clock.advance()
        for _ in 0..<1000 where cards.isSending("c1", callId: "q1") { await Task.yield() }
        #expect(reads.value == 1)
        #expect(!cards.isSending("c1", callId: "q1"))
    }

    @Test func aReadBackThatFailsIsTriedAgainBeforeTheCardUnlocks() async {
        let clock = ManualClock()
        let cards = SpadeCards(wait: { await clock.sleep($0) })
        cards.saw(SpadeCardsTests.card(.open), in: "c1")
        let reads = Count()
        _ = await cards.send("c1", callId: "q1", readBack: { reads.add(); return SpadeOutcome(ok: reads.value > 1) }) { SpadeOutcome(ok: true) }
        await clock.untilWaiting()
        clock.advance()
        for _ in 0..<1000 where reads.value == 0 { await Task.yield() }
        await clock.untilWaiting()
        #expect(reads.value == 1)
        #expect(cards.isSending("c1", callId: "q1"))
        clock.advance()
        for _ in 0..<1000 where cards.isSending("c1", callId: "q1") { await Task.yield() }
        #expect(reads.value == 2)
        #expect(!cards.isSending("c1", callId: "q1"))
    }

    @Test func aCardSettledBeforeTheWaitEndsIsNotReadBack() async {
        let clock = ManualClock()
        let cards = SpadeCards(wait: { await clock.sleep($0) })
        cards.saw(SpadeCardsTests.card(.open), in: "c1")
        let reads = Count()
        _ = await cards.send("c1", callId: "q1", readBack: { reads.add(); return SpadeOutcome(ok: true) }) { SpadeOutcome(ok: true) }
        await clock.untilWaiting()
        cards.saw(SpadeCardsTests.card(.settled), in: "c1")
        clock.advance()
        for _ in 0..<100 { await Task.yield() }
        #expect(reads.value == 0)
        #expect(!cards.isSending("c1", callId: "q1"))
    }
}

/// A clock the test moves: each wait holds until `advance`.
@MainActor final class ManualClock {
    private(set) var asked: [Duration] = []
    private var waiting: [CheckedContinuation<Void, Never>] = []
    func sleep(_ duration: Duration) async {
        asked.append(duration)
        await withCheckedContinuation { waiting.append($0) }
    }
    /// Returns once something waits on the clock.
    func untilWaiting() async {
        for _ in 0..<1000 where waiting.isEmpty { await Task.yield() }
    }
    func advance() {
        let all = waiting
        waiting = []
        for each in all { each.resume() }
    }
}

@MainActor final class Count {
    private(set) var value = 0
    func add() { value += 1 }
}

/// Holds a send until the test lets it go.
@MainActor final class Gate {
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var opened = false
    /// Something waits at the gate now.
    var held: Bool { !waiting.isEmpty }
    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiting.append($0) }
    }
    func open() {
        opened = true
        for each in waiting { each.resume() }
        waiting = []
    }
}

private final class QuietSession: ClientSession, @unchecked Sendable {
    func start(itemLimit: Int) {}
    func invoke(_ name: String, json: String) {}
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
}
