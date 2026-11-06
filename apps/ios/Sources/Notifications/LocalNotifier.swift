import Foundation
import UserNotifications

/// The UNUserNotificationCenter edge. Tests substitute it; everything above it is real.
protocol NotificationCenterPort: AnyObject, Sendable {
    func post(_ content: AlertContent) async
    func withdraw(_ identifiers: [String])
}

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
}

final class SystemNotificationCenter: NotificationCenterPort {
    func post(_ alert: AlertContent) async {
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.threadIdentifier = alert.threadIdentifier
        if !alert.threadId.isEmpty { content.targetContentIdentifier = alert.threadId }
        content.categoryIdentifier = alert.category
        switch alert.level {
        case .passive: content.interruptionLevel = .passive
        case .active: content.interruptionLevel = .active; content.sound = .default
        case .timeSensitive: content.interruptionLevel = .timeSensitive; content.sound = .default
        }
        // The finished summary names no thread: a tap opens ace where it was.
        var info: [String: String] = alert.threadId.isEmpty ? [:] : [NotificationKeys.threadId: alert.threadId]
        info[NotificationKeys.interactionId] = alert.interactionId
        info[NotificationKeys.approve] = alert.approveOption
        info[NotificationKeys.deny] = alert.denyOption
        info[NotificationKeys.hostId] = alert.hostId
        info[NotificationKeys.banner] = alert.banner ? "1" : "0"
        info[NotificationKeys.questionId] = alert.questionId
        if !alert.choices.isEmpty {
            info[NotificationKeys.choices] = alert.choices.map(\.id).joined(separator: String(NotificationKeys.choiceSeparator))
            // The buttons' titles are the options' labels: their category goes in first.
            let shape = NotificationCategories.Shape(labels: alert.choices.map(\.label), reply: alert.takesWords)
            UNUserNotificationCenter.current().setNotificationCategories(NotificationCategories.remember(shape, defaults: .standard))
        }
        content.userInfo = info
        // The stable daemon id, within its machine, is the request identifier, so a repeat
        // replaces rather than stacks, and another machine's equal id doesn't replace it.
        let request = UNNotificationRequest(identifier: alert.identifier, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
    func withdraw(_ identifiers: [String]) {
        guard !identifiers.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
    }
}

/// Lands every machine's alerts on this phone through one `AlertStack`: one notification per
/// thread, finishes in a burst folded into one, withdrawals by alert or by thread. Shared by
/// every machine's `LocalNotifier`, so a burst across machines folds too.
@MainActor final class AlertDesk {
    private let center: any NotificationCenterPort
    private let defaults: UserDefaults?
    private let now: () -> Double
    private(set) var stack: AlertStack
    init(center: any NotificationCenterPort, defaults: UserDefaults? = nil, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.center = center; self.defaults = defaults; self.now = now
        stack = defaults.map(AlertStack.load) ?? AlertStack()
    }
    func land(_ alert: AlertNotification, hostId: String?) async {
        let landing = stack.land(AlertContent(alert, hostId: hostId), alert: alert, now: now())
        save()
        center.withdraw(landing.withdraw)
        if let post = landing.post { await center.post(post) }
    }
    /// Retracted by the daemon: withdrawn if it is still its thread's, plus the ids earlier
    /// builds posted under (`AlertContent.requestIds`).
    func retract(_ alertIds: [String], hostId: String?) {
        guard !alertIds.isEmpty else { return }
        var ids: [String] = []
        for id in alertIds { ids += stack.retract(id, hostId: hostId) + AlertContent.requestIds(retracting: id, hostId: hostId) }
        save()
        center.withdraw(ids)
    }
    /// The thread was opened, or its request is answered or gone.
    func clear(threadId: String, hostId: String?) {
        let ids = stack.clear(threadId: threadId, hostId: hostId)
        guard !ids.isEmpty else { return }
        save()
        center.withdraw(ids)
    }
    private func save() { if let defaults { stack.save(defaults) } }
}

/// Posts the daemon's alerts once each, withdraws the ones canonical state no longer supports,
/// and remembers the catch-up cursor across launches.
@MainActor final class LocalNotifier {
    private let center: any NotificationCenterPort
    private let hostId: String?
    private let desk: AlertDesk
    private var store: LedgerStore?
    private(set) var ledger = NotificationLedger()
    init(center: any NotificationCenterPort, hostId: String? = nil, desk: AlertDesk? = nil) {
        self.center = center; self.hostId = hostId; self.desk = desk ?? AlertDesk(center: center)
    }

    func bind(_ store: LedgerStore) { self.store = store; ledger = store.load() }
    func receive(_ alert: AlertNotification) async {
        guard ledger.admit(alert.id) else { return }
        store?.save(ledger)
        guard alert.delivery?.post != false else { return }
        await desk.land(alert, hostId: hostId)
    }
    func catchUp(cursor: Int, entries: [AlertNotification], retracted: [String]) async {
        desk.retract(retracted, hostId: hostId)
        let fresh = entries.filter { ledger.admit($0.id) }
        ledger.advance(to: cursor)
        store?.save(ledger)
        for alert in fresh where alert.delivery?.post != false { await desk.land(alert, hostId: hostId) }
    }
    func withdraw(_ id: String) { center.withdraw([id]) }
    /// A local, non-daemon notice (an action that couldn't finish). It opens the thread.
    func notice(id: String, threadId: String, title: String, body: String, hostId: String? = nil) async {
        await center.post(.notice(id: id, threadId: threadId, title: title, body: body, hostId: hostId))
    }
}
