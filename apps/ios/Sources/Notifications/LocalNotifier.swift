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
}

final class SystemNotificationCenter: NotificationCenterPort {
    func post(_ alert: AlertContent) async {
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.threadIdentifier = alert.threadIdentifier
        content.targetContentIdentifier = alert.threadId
        content.categoryIdentifier = alert.category
        switch alert.level {
        case .passive: content.interruptionLevel = .passive
        case .active: content.interruptionLevel = .active; content.sound = .default
        case .timeSensitive: content.interruptionLevel = .timeSensitive; content.sound = .default
        }
        var info: [String: String] = [NotificationKeys.threadId: alert.threadId]
        info[NotificationKeys.interactionId] = alert.interactionId
        info[NotificationKeys.approve] = alert.approveOption
        info[NotificationKeys.deny] = alert.denyOption
        info[NotificationKeys.hostId] = alert.hostId
        info[NotificationKeys.banner] = alert.banner ? "1" : "0"
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

/// Posts the daemon's alerts once each, withdraws the ones canonical state no longer supports,
/// and remembers the catch-up cursor across launches.
@MainActor final class LocalNotifier {
    private let center: any NotificationCenterPort
    private let hostId: String?
    private var store: LedgerStore?
    private(set) var ledger = NotificationLedger()
    init(center: any NotificationCenterPort, hostId: String? = nil) { self.center = center; self.hostId = hostId }

    func bind(_ store: LedgerStore) { self.store = store; ledger = store.load() }
    func receive(_ alert: AlertNotification) async {
        guard ledger.admit(alert.id) else { return }
        store?.save(ledger)
        guard alert.delivery?.post != false else { return }
        await center.post(AlertContent(alert, hostId: hostId))
    }
    func catchUp(cursor: Int, entries: [AlertNotification], retracted: [String]) async {
        center.withdraw(retracted.flatMap { AlertContent.requestIds(retracting: $0, hostId: hostId) })
        let fresh = entries.filter { ledger.admit($0.id) }
        ledger.advance(to: cursor)
        store?.save(ledger)
        for alert in fresh where alert.delivery?.post != false { await center.post(AlertContent(alert, hostId: hostId)) }
    }
    func withdraw(_ id: String) { center.withdraw([id]) }
    /// A local, non-daemon notice (an action that couldn't finish). It opens the thread.
    func notice(id: String, threadId: String, title: String, body: String, hostId: String? = nil) async {
        await center.post(.notice(id: id, threadId: threadId, title: title, body: body, hostId: hostId))
    }
}
