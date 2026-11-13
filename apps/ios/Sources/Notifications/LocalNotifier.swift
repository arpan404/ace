import Foundation
import UserNotifications

/// The UNUserNotificationCenter edge. Tests substitute it; everything above it is real.
protocol NotificationCenterPort: AnyObject, Sendable {
    func post(_ content: AlertContent) async
    func withdraw(_ identifiers: [String])
    /// Withdraws the service extension's copies of `thread`'s earlier alerts (ADR 0106): delivered
    /// pushes standing for it whose alert isn't `alert`. They carry APNs' identifier, so posting
    /// under the thread's own doesn't replace them.
    func withdrawPushed(standingFor thread: String, except alert: String)
}

final class SystemNotificationCenter: NotificationCenterPort {
    func post(_ alert: AlertContent) async {
        let content = UNMutableNotificationContent()
        alert.fill(content)
        if !alert.choices.isEmpty {
            // The buttons' titles are the options' labels: their category goes in first.
            let shape = NotificationCategories.Shape(labels: alert.choices.map(\.label), reply: alert.takesWords)
            UNUserNotificationCenter.current().setNotificationCategories(NotificationCategories.remember(shape, defaults: .standard))
        }
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
        // A push the service extension rewrote has APNs' identifier, not the app's: it names
        // the alert and the thread it stands for instead (ADR 0106).
        let wanted = Set(identifiers)
        center.getDeliveredNotifications { delivered in
            let pushed = delivered.filter { note in
                let info = note.request.content.userInfo
                return [NotificationKeys.pushedAlert, NotificationKeys.standsFor].contains { (info[$0] as? String).map(wanted.contains) ?? false }
            }
            if !pushed.isEmpty { center.removeDeliveredNotifications(withIdentifiers: pushed.map(\.request.identifier)) }
        }
    }
    func withdrawPushed(standingFor thread: String, except alert: String) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let older = delivered.filter { note in
                let info = note.request.content.userInfo
                // Only the extension's copies have `pushedAlert`; the app's own post is never matched.
                guard let pushed = info[NotificationKeys.pushedAlert] as? String else { return false }
                return pushed != alert && info[NotificationKeys.standsFor] as? String == thread
            }
            if !older.isEmpty { center.removeDeliveredNotifications(withIdentifiers: older.map(\.request.identifier)) }
        }
    }
}

/// Lands every machine's alerts on this phone through one `AlertStack`: one notification per
/// thread, finishes in a burst folded into one, withdrawals by alert or by thread. Shared by
/// every machine's `LocalNotifier`, so a burst across machines folds too.
@MainActor final class AlertDesk {
    private let center: any NotificationCenterPort
    private let defaults: UserDefaults?
    private let now: () -> Double
    /// Alerts the service extension already showed from a push (ADR 0106).
    let pushed: PushedAlerts
    private(set) var stack: AlertStack
    /// The last post asked for: every post waits for the one before, so they land in order.
    private var effects: Task<Void, Never>?
    /// Notifications with a post queued or out, by identifier: the latest post's generation, or
    /// a withdrawal's when one came after it.
    private var pending: [String: Pending] = [:]
    private var generation = 0
    private struct Pending { let generation: Int; let withdrawn: Bool }
    /// Landings whose post is queued or out, by serial, with the notifier that asked for each.
    private var landing: [Int: (owner: ObjectIdentifier, threadId: String, hostId: String?)] = [:]
    private var landings = 0
    init(center: any NotificationCenterPort, defaults: UserDefaults? = nil, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
         pushed: PushedAlerts = PushedAlerts(defaults: nil)) {
        self.center = center; self.defaults = defaults; self.now = now; self.pushed = pushed
        stack = defaults.map(AlertStack.load) ?? AlertStack()
    }
    /// Lands an alert; `owner`'s landings still queued or out can be cancelled (`cancel`).
    func land(_ alert: AlertNotification, hostId: String?, owner: ObjectIdentifier? = nil) async {
        let landed = stack.land(AlertContent(alert, hostId: hostId), alert: alert, now: now())
        save()
        withdraw(landed.withdraw)
        guard let content = landed.post else { return }
        let thread = AlertStack.thread(alert.threadId, hostId: hostId)
        if content.identifier == thread {
            let request = AlertContent.requestId(alert.id, hostId: hostId)
            // This alert is the thread's one notification now: a push of an earlier one (shown
            // while ace was closed) goes, as the thread's own post would replace it.
            center.withdrawPushed(standingFor: thread, except: request)
            // A push already showed this alert (the socket's ack was lost, or catch-up brought
            // it): the stack keeps it as the thread's, and withdrawing the thread withdraws it.
            if pushed.contains(request) { return }
        }
        landings += 1
        let serial = landings
        if let owner { landing[serial] = (owner, alert.threadId, hostId) }
        await post(content).value
        landing[serial] = nil
    }
    /// `owner` went (its machine let go): what it landed that hasn't reached the notification
    /// center yet never does, and what is out right now is withdrawn once it has landed.
    func cancel(owner: ObjectIdentifier) {
        let mine = landing.filter { $0.value.owner == owner }
        guard !mine.isEmpty else { return }
        for serial in mine.keys { landing[serial] = nil }
        for entry in mine.values { clear(threadId: entry.threadId, hostId: entry.hostId) }
    }
    /// Retracted by the daemon: withdrawn if it is still its thread's, plus the ids earlier
    /// builds posted under (`AlertContent.requestIds`).
    func retract(_ alertIds: [String], hostId: String?) {
        guard !alertIds.isEmpty else { return }
        let before = stack
        var landings: [AlertStack.Landing] = []
        for id in alertIds {
            var landing = stack.retract(id, hostId: hostId)
            landing.withdraw += AlertContent.requestIds(retracting: id, hostId: hostId)
            landings.append(landing)
        }
        apply(landings, since: before)
    }
    /// Every notification from one machine, such as one turned off on this phone.
    func clear(hostId: String) {
        let before = stack
        apply([stack.clear(hostId: hostId)], since: before)
    }
    /// The thread was opened, or its request is answered or gone.
    func clear(threadId: String, hostId: String?) {
        let before = stack
        apply([stack.clear(threadId: threadId, hostId: hostId)], since: before)
    }
    /// Every change to the stack is kept, folded finishes included, and the summary follows
    /// what is left of it: posted again over the rest, or withdrawn.
    private func apply(_ landings: [AlertStack.Landing], since before: AlertStack) {
        if stack != before { save() }
        var ids = landings.flatMap(\.withdraw)
        let summaryMoved = landings.contains { $0.post != nil || $0.withdraw.contains(AlertStack.summaryId) }
        let summary = summaryMoved ? stack.summary : nil
        if summary != nil { ids.removeAll { $0 == AlertStack.summaryId } }
        withdraw(ids)
        if let summary { post(summary) }
    }
    /// Withdrawn now; a post of it still queued won't land, and one already out is withdrawn
    /// again once it has.
    func withdraw(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        for id in ids where pending[id] != nil {
            generation += 1
            pending[id] = Pending(generation: generation, withdrawn: true)
        }
        center.withdraw(ids)
    }
    /// Posted after every earlier post, unless a later post or withdrawal of the same
    /// notification overtakes it first. Done when it has landed or been skipped.
    @discardableResult func post(_ content: AlertContent) -> Task<Void, Never> {
        let id = content.identifier
        generation += 1
        let mine = generation
        pending[id] = Pending(generation: mine, withdrawn: false)
        let previous = effects
        let center = center
        let task = Task { @MainActor [weak self] in
            await previous?.value
            guard let self else { return }
            guard self.pending[id]?.generation == mine else {
                // Overtaken by a withdrawal that nothing posted after: nothing is left to undo.
                if self.pending[id]?.withdrawn == true { self.pending[id] = nil }
                return
            }
            await center.post(content)
            guard let now = self.pending[id] else { return }
            if now.generation == mine || now.withdrawn { self.pending[id] = nil }
            if now.withdrawn { center.withdraw([id]) }
        }
        effects = task
        return task
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
    /// False once its machine is turned off or detached: alerts still advance the ledger, so
    /// none is posted later, but nothing lands any more, even from a task already under way.
    private(set) var valid = true
    init(center: any NotificationCenterPort, hostId: String? = nil, desk: AlertDesk? = nil) {
        self.center = center; self.hostId = hostId; self.desk = desk ?? AlertDesk(center: center)
    }

    func bind(_ store: LedgerStore) { self.store = store; ledger = store.load() }
    /// Its machine was turned off or let go: nothing it still has under way lands, and what it
    /// handed the desk that hasn't landed yet is called back.
    func invalidate() {
        valid = false
        desk.cancel(owner: ObjectIdentifier(self))
    }
    func receive(_ alert: AlertNotification) async {
        guard ledger.admit(alert.id) else { return }
        store?.save(ledger)
        guard alert.delivery?.post != false, valid else { return }
        await desk.land(alert, hostId: hostId, owner: ObjectIdentifier(self))
    }
    func catchUp(cursor: Int, entries: [AlertNotification], retracted: [String]) async {
        desk.retract(retracted, hostId: hostId)
        let fresh = entries.filter { ledger.admit($0.id) }
        ledger.advance(to: cursor)
        store?.save(ledger)
        // Checked before each one: an earlier post can be awaited past a turn-off.
        for alert in fresh where alert.delivery?.post != false {
            guard valid else { return }
            await desk.land(alert, hostId: hostId, owner: ObjectIdentifier(self))
        }
    }
    func withdraw(_ id: String) { desk.withdraw([id]) }
    /// A local, non-daemon notice (an action that couldn't finish). It opens the thread.
    func notice(id: String, threadId: String, title: String, body: String, hostId: String? = nil) async {
        await desk.post(.notice(id: id, threadId: threadId, title: title, body: body, hostId: hostId)).value
    }
}
