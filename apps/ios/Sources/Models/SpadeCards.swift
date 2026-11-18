import Foundation
import Observation

/// Spade's cards of questions as the phone holds them (ADR 0154), by conversation and call,
/// beyond any one view: a card drawn again (its conversation left and reopened) is still the
/// same card. A card whose reply is out is locked until Spade's update moves it on, so it can't
/// be sent twice.
@MainActor @Observable final class SpadeCards {
    /// A card of questions by its conversation and call.
    struct Key: Hashable, Sendable {
        let conversation: String
        let callId: String
    }

    /// Cards sent and not yet settled, with the standing each was sent from.
    private var sent: [Key: SpadeQuestionCard.Standing] = [:]
    /// The cards on screen now, as Spade last put them.
    private var shown: [Key: SpadeQuestionCard] = [:]

    /// Whether Send, Answer later and Never mind are off on this card.
    func isSending(_ conversation: String, callId: String) -> Bool {
        sent[Key(conversation: conversation, callId: callId)] != nil
    }

    /// Sends a card's reply through `post`, once: locked from the tap until Spade's update moves
    /// the card on, or at once again when the reply is refused. A card already out isn't sent.
    func send(_ conversation: String, callId: String, via post: () async -> SpadeOutcome) async -> SpadeOutcome {
        let key = Key(conversation: conversation, callId: callId)
        guard sent[key] == nil else { return SpadeOutcome(ok: false) }
        sent[key] = shown[key]?.standing ?? .open
        let outcome = await post()
        if !outcome.ok { sent[key] = nil }
        return outcome
    }

    /// Spade put `card` in `conversation`: a sent card whose standing moved on is settled.
    func saw(_ card: SpadeQuestionCard, in conversation: String) {
        let key = Key(conversation: conversation, callId: card.callId)
        // A settled card is done: only open and later ones are kept.
        if card.standing == .settled { shown[key] = nil } else if shown[key] != card { shown[key] = card }
        if let from = sent[key], from != card.standing { sent[key] = nil }
    }

    /// Another machine's runtime: nothing of this one's cards applies.
    func reset() {
        sent = [:]
        shown = [:]
    }
}
