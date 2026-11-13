import Foundation
import UserNotifications

enum NotificationKeys {
    static let threadId = "threadId"
    static let interactionId = "interactionId"
    static let approve = "approveOption"
    static let deny = "denyOption"
    /// The machine that raised the alert, so a tap or an answer goes back to it.
    static let hostId = "hostId"
    /// "0" when the alert should go to the list without a banner over the open app.
    static let banner = "banner"
    /// The question a choice or Reply answers, and the option ids of its buttons, in order.
    static let questionId = "questionId"
    static let choices = "choices"
    static let choiceSeparator: Character = "\u{1F}"
    /// An outside app's sign-in (`AccessAlert`): which request, who asks and when it ends.
    static let accessRequestId = "accessRequestId"
    static let accessClient = "accessClient"
    static let accessExpiresAt = "accessExpiresAt"
}

extension AlertContent {
    /// What Notification Center shows for this alert, with the keys a tap or an answer reads
    /// back.
    func fill(_ content: UNMutableNotificationContent) {
        content.title = title
        content.body = body
        content.threadIdentifier = threadIdentifier
        if !threadId.isEmpty { content.targetContentIdentifier = threadId }
        content.categoryIdentifier = category
        switch level {
        case .passive: content.interruptionLevel = .passive; content.sound = nil
        case .active: content.interruptionLevel = .active; content.sound = .default
        case .timeSensitive: content.interruptionLevel = .timeSensitive; content.sound = .default
        }
        content.userInfo = userInfo
    }
    var userInfo: [String: String] {
        // The finished summary names no thread: a tap opens ace where it was.
        var info: [String: String] = threadId.isEmpty ? [:] : [NotificationKeys.threadId: threadId]
        info[NotificationKeys.interactionId] = interactionId
        info[NotificationKeys.approve] = approveOption
        info[NotificationKeys.deny] = denyOption
        info[NotificationKeys.hostId] = hostId
        info[NotificationKeys.banner] = banner ? "1" : "0"
        info[NotificationKeys.questionId] = questionId
        if !choices.isEmpty {
            info[NotificationKeys.choices] = choices.map(\.id).joined(separator: String(NotificationKeys.choiceSeparator))
        }
        if let access { info.merge(access.info) { $1 } }
        return info
    }
}
