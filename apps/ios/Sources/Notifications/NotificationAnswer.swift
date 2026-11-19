import Foundation

/// What the person answered from a notification or the Live Activity, read from the action they
/// took and the alert's own ids. Pure.
enum NotificationAnswer: Equatable, Sendable {
    /// Allow or Deny: an approval's exact option.
    case option(interactionId: String, optionId: String)
    /// A question's offered option, or the person's own words where it takes them.
    case question(interactionId: String, questionId: String, value: String)
    /// Words for the thread's next message.
    case reply(String)

    /// Nil for a tap, or anything that names no answer (an empty reply, a button past the
    /// question's options): those open the thread instead.
    init?(action: String, info: [String: String], text: String?) {
        let interaction = info[NotificationKeys.interactionId]
        let words = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch action {
        case NotificationActionID.approve, NotificationActionID.deny:
            let key = action == NotificationActionID.approve ? NotificationKeys.approve : NotificationKeys.deny
            guard let interaction, let option = info[key] else { return nil }
            self = .option(interactionId: interaction, optionId: option)
        case NotificationActionID.reply:
            guard !words.isEmpty else { return nil }
            self = .reply(words)
        case NotificationActionID.answer:
            guard let interaction, let question = info[NotificationKeys.questionId], !words.isEmpty else { return nil }
            self = .question(interactionId: interaction, questionId: question, value: words)
        default:
            let ids = info[NotificationKeys.choices]?.split(separator: NotificationKeys.choiceSeparator).map(String.init) ?? []
            guard let index = NotificationActionID.choiceIndex(action), ids.indices.contains(index),
                  let interaction, let question = info[NotificationKeys.questionId] else { return nil }
            self = .question(interactionId: interaction, questionId: question, value: ids[index])
        }
    }

    /// The bridge action (`bridge/notifications.ts`).
    func action(requestId: String, threadId: String) -> [String: Any] {
        switch self {
        case .option(let interaction, let option):
            ["type": "notifications.resolve", "requestId": requestId, "threadId": threadId, "interactionId": interaction, "optionId": option]
        case .question(let interaction, let question, let value):
            ["type": "notifications.answer", "requestId": requestId, "threadId": threadId, "interactionId": interaction,
             "questionId": question, "value": value]
        case .reply(let text):
            ["type": "notifications.reply", "requestId": requestId, "threadId": threadId, "text": text]
        }
    }
}

/// The quiet follow-up an answer leaves when the machine didn't confirm it: what happened and
/// what the person can do. Nil once confirmed (the alert just goes). A reply that didn't go
/// repeats the words, so they aren't lost.
enum ActionNotice {
    struct Words: Equatable, Sendable { let title: String; let body: String }
    /// A reply quoted back is cut here.
    static let quoteLimit = 120

    static func words(_ outcome: NotificationPatch.ActionOutcome?, for answer: NotificationAnswer) -> Words? {
        if case .reply(let text) = answer { return replyWords(outcome, text: text) }
        switch outcome {
        case .confirmed?: return nil
        case .stale?: return Words(title: "Already answered", body: "That request was answered or withdrawn before your answer arrived.")
        case .saved?: return Words(title: "Answer saved", body: "It sends when your machine is reachable. Open ace to check.")
        case .refused?: return Words(title: "Request not answered", body: "Your machine didn't accept the answer. Open ace to see the request.")
        default: return Words(title: "Request not answered", body: "Couldn't reach your machine. Open ace to answer.")
        }
    }
    private static func replyWords(_ outcome: NotificationPatch.ActionOutcome?, text: String) -> Words? {
        let quote = text.count > quoteLimit ? "“\(text.prefix(quoteLimit))…”" : "“\(text)”"
        switch outcome {
        case .confirmed?: return nil
        case .saved?: return Words(title: "Message saved", body: "It sends when your machine is reachable.")
        case .refused?, .stale?: return Words(title: "Message not sent", body: "Your machine didn't accept it. \(quote)")
        default: return Words(title: "Message not sent", body: "Couldn't reach your machine. \(quote)")
        }
    }
}
