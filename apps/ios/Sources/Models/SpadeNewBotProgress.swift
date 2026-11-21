import Foundation

/// New bot's progress (`bridge/spade-new-bot.ts`): what the sheet does next and why it waits. A
/// bot Spade made but whose first message didn't go (an older Spade sends it on its own) stays
/// made: the next try sends the message to its conversation, never makes a second bot.
struct SpadeNewBotProgress: Equatable {
    enum Next: Equatable {
        case create
        case send(conversation: String)
    }
    /// The made bot's conversation, while its first message still has to go.
    private(set) var made: String?
    private(set) var problem: String?

    var next: Next { made.map { .send(conversation: $0) } ?? .create }

    /// Making the bot came back: the conversation to open, or nil to stay and say why.
    mutating func land(_ answer: SpadeNewBotAnswer) -> String? {
        if answer.ok, let conversation = answer.conversation {
            problem = nil
            return conversation
        }
        if let conversation = answer.conversation { made = conversation }
        problem = answer.problem
        return nil
    }
    /// The first message, sent again, came back: the conversation to open once it went.
    mutating func sent(_ outcome: SpadeOutcome, to conversation: String) -> String? {
        guard outcome.ok else {
            problem = outcome.problem ?? "Couldn't send. Try again."
            return nil
        }
        made = nil
        problem = nil
        return conversation
    }
}
