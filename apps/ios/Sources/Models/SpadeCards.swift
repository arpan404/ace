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

    /// One reply sent: its own id, so only its own refusal unlocks it, and the standing the card
    /// was sent from.
    private struct Submission {
        let id: Int
        let from: SpadeQuestionCard.Standing
    }

    /// How long an accepted card waits for Spade's update before it is read back.
    static let recheck: Duration = .seconds(10)
    /// Read-backs tried before the card unlocks anyway.
    static let rereads = 3

    private let wait: (Duration) async -> Void

    /// `wait` is the clock the recheck sleeps on.
    init(wait: @escaping (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
        self.wait = wait
    }

    /// Cards sent and not yet settled.
    private var sent: [Key: Submission] = [:]
    private var submissions = 0
    /// The cards on screen now, as Spade last put them.
    private var shown: [Key: SpadeQuestionCard] = [:]

    /// Whether Send, Answer later and Never mind are off on this card.
    func isSending(_ conversation: String, callId: String) -> Bool {
        sent[Key(conversation: conversation, callId: callId)] != nil
    }

    /// Sends a card's reply through `post`, once: locked from the tap until Spade's update moves
    /// the card on, or at once again when the reply is refused. A card already out isn't sent.
    /// Accepted but still not settled after `recheck`, the card is read back (`readBack`), so an
    /// update the live stream missed can't keep it locked for good.
    func send(_ conversation: String, callId: String, readBack: @escaping () async -> SpadeOutcome,
              via post: () async -> SpadeOutcome) async -> SpadeOutcome {
        let key = Key(conversation: conversation, callId: callId)
        guard sent[key] == nil else { return SpadeOutcome(ok: false) }
        submissions += 1
        let mine = Submission(id: submissions, from: shown[key]?.standing ?? .open)
        sent[key] = mine
        let outcome = await post()
        // Refused: unlocked, unless the card moved on and was sent again meanwhile.
        if !outcome.ok, sent[key]?.id == mine.id { sent[key] = nil }
        if outcome.ok { Task { await recheck(key, id: mine.id, readBack: readBack) } }
        return outcome
    }

    /// Still locked by the same send after the wait: read the card back, then unlock it, as it
    /// has settled by now or is still open to answer. A read that fails is tried again first.
    private func recheck(_ key: Key, id: Int, readBack: () async -> SpadeOutcome) async {
        for _ in 0..<Self.rereads {
            await wait(Self.recheck)
            guard sent[key]?.id == id else { return }
            if await readBack().ok { break }
        }
        if sent[key]?.id == id { sent[key] = nil }
    }

    /// Spade put `card` in `conversation`: a sent card whose standing moved on is settled.
    func saw(_ card: SpadeQuestionCard, in conversation: String) {
        let key = Key(conversation: conversation, callId: card.callId)
        // A settled card is done: only open and later ones are kept.
        if card.standing == .settled { shown[key] = nil } else if shown[key] != card { shown[key] = card }
        if let out = sent[key], out.from != card.standing { sent[key] = nil }
    }

    /// Another machine's runtime: nothing of this one's cards applies.
    func reset() {
        sent = [:]
        shown = [:]
    }
}
