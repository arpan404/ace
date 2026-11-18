import Foundation
import Testing
@testable import Ace

/// A card sent from the phone stays locked wherever it is drawn until Spade's update settles it.
@Suite @MainActor struct SpadeSentCardTests {
    private func card(_ standing: SpadeQuestionCard.Standing) -> SpadeModel.Bubble {
        .question(SpadeQuestionCard(callId: "q1", label: "Planner asks: Go?", standing: standing,
                                    questions: [], answers: nil, line: nil))
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
}
