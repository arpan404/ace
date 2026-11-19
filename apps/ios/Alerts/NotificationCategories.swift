import CryptoKit
import Foundation
import UserNotifications

enum NotificationActionID {
    static let approve = "ACE_APPROVE"
    static let deny = "ACE_DENY"
    /// Reply to a thread: the words go as its next message.
    static let reply = "ACE_REPLY"
    /// A question answered in the person's own words.
    static let answer = "ACE_ANSWER"
    /// The n-th option of a short question: `ACE_CHOICE_0`…
    static let choicePrefix = "ACE_CHOICE_"
    static func choice(_ index: Int) -> String { "\(choicePrefix)\(index)" }
    static func choiceIndex(_ action: String) -> Int? {
        action.hasPrefix(choicePrefix) ? Int(action.dropFirst(choicePrefix.count)) : nil
    }

    /// Every action answers without opening the app and needs an unlocked device: an answer or a
    /// message can make an agent run things.
    static var categories: Set<UNNotificationCategory> {
        let allow = UNNotificationAction(identifier: approve, title: "Allow", options: [.authenticationRequired])
        let refuse = UNNotificationAction(identifier: deny, title: "Deny", options: [.authenticationRequired, .destructive])
        return [UNNotificationCategory(identifier: AlertContent.approvalCategory, actions: [allow, refuse], intentIdentifiers: []),
                UNNotificationCategory(identifier: AlertContent.threadCategory, actions: [], intentIdentifiers: []),
                UNNotificationCategory(identifier: AlertContent.replyCategory, actions: [replyAction(reply, title: "Reply")], intentIdentifiers: []),
                UNNotificationCategory(identifier: AlertContent.answerCategory, actions: [replyAction(answer, title: "Reply")], intentIdentifiers: [])]
    }
    static func replyAction(_ id: String, title: String) -> UNTextInputNotificationAction {
        UNTextInputNotificationAction(identifier: id, title: title, options: [.authenticationRequired],
                                      textInputButtonTitle: "Send", textInputPlaceholder: "Message")
    }
}

/// A short question's options as buttons. Categories carry fixed titles, so each set of labels
/// gets its own category, registered before its alert posts. The most recent ones are kept and
/// registered again at launch, so alerts still in Notification Center keep their buttons.
enum NotificationCategories {
    static let prefix = "ACE_CHOICE."
    static let kept = 24
    static let storageKey = "ace.notifications.choiceCategories"
    struct Shape: Codable, Equatable, Sendable { let labels: [String]; let reply: Bool }

    /// The same labels in the same order always name the same category.
    static func choiceId(_ labels: [String], reply: Bool) -> String {
        let digest = SHA256.hash(data: Data((labels + [reply ? "1" : "0"]).joined(separator: "\u{1F}").utf8))
        return prefix + digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }
    static func category(_ shape: Shape) -> UNNotificationCategory {
        var actions: [UNNotificationAction] = shape.labels.enumerated().map { index, label in
            UNNotificationAction(identifier: NotificationActionID.choice(index), title: label, options: [.authenticationRequired])
        }
        if shape.reply { actions.append(NotificationActionID.replyAction(NotificationActionID.answer, title: "Reply")) }
        return UNNotificationCategory(identifier: choiceId(shape.labels, reply: shape.reply), actions: actions, intentIdentifiers: [])
    }
    /// Remembers `shape` (newest last, bounded) and returns every category to register.
    static func remember(_ shape: Shape?, defaults: UserDefaults) -> Set<UNNotificationCategory> {
        var shapes = (defaults.data(forKey: storageKey)).flatMap { try? JSONDecoder().decode([Shape].self, from: $0) } ?? []
        if let shape {
            shapes.removeAll { $0 == shape }
            shapes.append(shape)
            shapes = Array(shapes.suffix(kept))
            if let data = try? JSONEncoder().encode(shapes) { defaults.set(data, forKey: storageKey) }
        }
        return NotificationActionID.categories.union(shapes.map(category))
    }
}
