import Foundation
import Testing
@testable import Ace

/// A card sent from the phone stays locked wherever it is drawn until Spade's update settles it.
@Suite @MainActor struct SpadeCardsTests {
    static func card(_ standing: SpadeQuestionCard.Standing) -> SpadeQuestionCard {
        SpadeQuestionCard(callId: "q1", label: "Planner asks: Go?", standing: standing, questions: [], answers: nil, line: nil)
    }
    private func card(_ standing: SpadeQuestionCard.Standing) -> SpadeModel.Bubble {
        .question(SpadeCardsTests.card(standing))
    }

    @Test func aSentCardStaysLockedThroughLeavingAndReopeningUntilItSettles() async {
        let spade = SpadeModel()
        spade.apply(.row(conversation: "c1", key: "k", bubble: card(.open)))
        var posts = 0
        let outcome = await spade.cards.send("c1", callId: "q1") { posts += 1; return SpadeOutcome(ok: true) }
        #expect(outcome.ok)
        #expect(spade.cards.isSending("c1", callId: "q1"))

        // Another conversation, then back: the card is drawn again, still open, still locked.
        spade.apply(.row(conversation: "c2", key: "k", bubble: card(.open)))
        spade.apply(.row(conversation: "c1", key: "k", bubble: card(.open)))
        #expect(spade.cards.isSending("c1", callId: "q1"))
        _ = await spade.cards.send("c1", callId: "q1") { posts += 1; return SpadeOutcome(ok: true) }
        #expect(posts == 1)
        // The same call in another conversation is another card.
        #expect(!spade.cards.isSending("c2", callId: "q1"))

        spade.apply(.row(conversation: "c1", key: "k", bubble: card(.settled)))
        #expect(!spade.cards.isSending("c1", callId: "q1"))
    }

    @Test func aRefusedCardUnlocksAtOnce() async {
        let spade = SpadeModel()
        spade.apply(.row(conversation: "c1", key: "k", bubble: card(.open)))
        let outcome = await spade.cards.send("c1", callId: "q1") { SpadeOutcome(ok: false, message: "At most 14.") }
        #expect(!outcome.ok)
        #expect(!spade.cards.isSending("c1", callId: "q1"))
    }

    @Test func anOlderRefusalLeavesANewerSendLocked() async {
        let cards = SpadeCards()
        cards.saw(SpadeCardsTests.card(.open), in: "c1")
        let older = Gate()
        let first = Task { await cards.send("c1", callId: "q1") { await older.wait(); return SpadeOutcome(ok: false, message: "Not open.") } }
        while !cards.isSending("c1", callId: "q1") { await Task.yield() }
        // Spade moves the card on (another device left it for later), and it is sent again.
        cards.saw(SpadeCardsTests.card(.later), in: "c1")
        #expect(await cards.send("c1", callId: "q1") { SpadeOutcome(ok: true) }.ok)

        older.open()
        #expect(await !first.value.ok)
        #expect(cards.isSending("c1", callId: "q1"))
    }
}

/// Holds a send until the test lets it go.
@MainActor final class Gate {
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var opened = false
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
