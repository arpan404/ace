import Foundation
import Observation
import CryptoKit
import UserNotifications

/// The permission edge, substituted in tests.
protocol NotificationAuthorizer: Sendable {
    func status() async -> NotificationCoordinator.Permission
    func request() async -> Bool
}
struct SystemAuthorizer: NotificationAuthorizer {
    func status() async -> NotificationCoordinator.Permission {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .notDetermined: .notDetermined
        case .denied: .denied
        default: .allowed
        }
    }
    func request() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }
}

/// Owns the on/off switch, permission and app state, and routes the bridge's notification patches.
/// Alerts only ever come from the daemon (live frames or catch-up); nothing here reads status.
/// Every paired machine's runtime attaches with its own catch-up ledger; alerts carry their
/// machine, so a tap or an answer goes back to the machine that raised it.
@MainActor @Observable final class NotificationCoordinator {
    enum Permission: Sendable { case unknown, notDetermined, denied, allowed }
    private enum Keys {
        static let enabled = "ace.notifications.enabled", asked = "ace.notifications.asked"
        static let muted = "ace.notifications.mutedMachines"
        static let liveActivity = "ace.lockScreen.liveActivity"
        static let bridgePosted = "ace.notifications.bridgePosted"
    }
    /// The bridge notifications remembered per machine, newest last; older ones have long gone.
    static let bridgePostedLimit = 256

    private(set) var enabled: Bool
    private(set) var permission: Permission = .unknown
    /// Each machine's own `notification.preferences` (quiet hours), host id → preferences.
    private(set) var preferencesByMachine: [String: NotificationPreferences] = [:]
    /// Machines this phone turned alerts off for; they register no delivery and post nothing.
    private(set) var muted: Set<String>
    /// Per-thread snoozes this phone set (`notification.snooze`), host id → thread id → until (ms).
    private(set) var snoozesByMachine: [String: [String: Double]] = [:]
    /// This phone's banners, system categories and quiet hours, the same for every machine.
    private(set) var phone: PhoneNotificationPrefs
    /// Attached runtimes by host, in attach order.
    @ObservationIgnored private(set) var machines: [(hostId: String, model: ClientModel, notifier: LocalNotifier)] = []
    /// The first attached machine: settings and the one-time permission ask read it.
    var model: ClientModel? { machines.first?.model }
    /// Local notices (an action that couldn't finish) and withdrawals; no ledger of its own.
    @ObservationIgnored let notifier: LocalNotifier
    /// Every machine's alerts land here: one per thread, bursts of finishes folded into one.
    @ObservationIgnored let desk: AlertDesk
    @ObservationIgnored private let center: any NotificationCenterPort
    @ObservationIgnored private let authorizer: any NotificationAuthorizer
    @ObservationIgnored let defaults: UserDefaults
    @ObservationIgnored let now: () -> Double
    @ObservationIgnored private(set) var foreground = true
    @ObservationIgnored private var outcomes: [String: Waiter<NotificationPatch.ActionOutcome>] = [:]
    @ObservationIgnored private var feeds: [String: [Waiter<Bool>]] = [:]
    @ObservationIgnored let sleep: @Sendable (Duration) async -> Void
    @ObservationIgnored let makeId: () -> String
    /// Opens short-lived connections to every paired machine when no UI exists (a background launch).
    @ObservationIgnored let connectInBackground: @MainActor (NotificationCoordinator) async -> [ClientModel]
    @ObservationIgnored var transient: [ClientModel] = []
    /// A tapped thread waiting for the UI connection of a cold launch.
    @ObservationIgnored var pendingLink: (threadId: String, hostId: String?)?
    /// The one Live Activity and the widgets' snapshot, across every attached machine.
    @ObservationIgnored let lockScreen: LockScreenHub
    /// Approvals the daemon alerted about, by host and thread, for the Live Activity's
    /// Allow/Deny; and which alert raised each, so a retraction drops it.
    @ObservationIgnored var approvals: [String: LockRequest] = [:]
    @ObservationIgnored var approvalAlerts: [String: String] = [:]
    /// Settings › Notifications › Live Activity.
    private(set) var liveActivity: Bool
    /// Each machine's sign-ins waiting for approval when it last said, by host.
    @ObservationIgnored var accessSeen: [String: Set<String>] = [:]
    /// Usage-limit and automation-run notifications posted for each machine, oldest first,
    /// withdrawn with the machine's others. Kept across launches: Notification Center keeps them.
    @ObservationIgnored var bridgePosted: [String: [String]] = [:]
    /// A tapped sign-in waiting for its machine's runtime (a cold launch).
    @ObservationIgnored var pendingAccess: (alert: AccessAlert, hostId: String?)?
    /// The person's name for a machine, for "Claude wants to sign in to studio".
    @ObservationIgnored var machineName: (String) -> String? = { _ in nil }
    /// This phone's push address (ADR 0106), once iOS gave a token; every machine's sync carries it.
    @ObservationIgnored var push: PushRegistration?
    /// Asks iOS for a push token (`registerForRemoteNotifications`); the app delegate sets it.
    @ObservationIgnored var requestPushToken: @MainActor () -> Void = {}

    init(center: any NotificationCenterPort = SystemNotificationCenter(), authorizer: any NotificationAuthorizer = SystemAuthorizer(),
         defaults: UserDefaults = .standard, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
         sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
         makeId: @escaping () -> String = { UUID().uuidString.lowercased() },
         connectInBackground: @escaping @MainActor (NotificationCoordinator) async -> [ClientModel] = BackgroundConnection.connect,
         lockScreenEdges: LockScreenHub.Edges? = nil, pushed: PushedAlerts = PushedAlerts(defaults: nil)) {
        desk = AlertDesk(center: center, defaults: defaults, now: now, pushed: pushed)
        notifier = LocalNotifier(center: center, desk: desk)
        self.center = center
        self.authorizer = authorizer; self.defaults = defaults; self.now = now; self.sleep = sleep
        self.makeId = makeId; self.connectInBackground = connectInBackground
        enabled = defaults.bool(forKey: Keys.enabled)
        muted = Set(defaults.stringArray(forKey: Keys.muted) ?? [])
        phone = PhoneNotificationPrefs.load(defaults)
        liveActivity = defaults.object(forKey: Keys.liveActivity) as? Bool ?? true
        bridgePosted = defaults.dictionary(forKey: Keys.bridgePosted) as? [String: [String]] ?? [:]
        self.lockScreen = LockScreenHub(edges: lockScreenEdges ?? .inert, now: { Date(timeIntervalSince1970: now() / 1000) }, sleep: sleep)
        self.lockScreen.allowed = liveActivity
        self.lockScreen.read = { [weak self] in self?.lockScreenInput() ?? ([], [:]) }
        LockScreenActions.handler = { [weak self] request, allow in await self?.answer(request, allow: allow) }
    }

    /// Call before `model.connect`: patches from that runtime reach this coordinator, bound to that
    /// machine's own ledger. Background connections still open are closed first, so two runtimes
    /// never share one machine's storage.
    func attach(_ model: ClientModel, target: ConnectionTarget) async {
        if transient.contains(where: { $0 !== model }) { await releaseTransient() }
        // The machine as the phone keys it, whichever route this connection takes.
        let machine = target.scope
        let scope = SHA256.hash(data: Data("\(machine.hostId)\u{0}\(machine.deviceId)".utf8)).map { String(format: "%02x", $0) }.joined()
        let ledger = LocalNotifier(center: center, hostId: machine.hostId, desk: desk)
        ledger.bind(LedgerStore(scope: scope, defaults: defaults))
        machines.removeAll { $0.hostId == machine.hostId || $0.model === model }
        machines.append((machine.hostId, model, ledger))
        let hostId = machine.hostId
        model.notificationSink = { [weak self] patch in self?.receive(patch, from: hostId) }
        model.liveActivity.onChange = { [weak self] in self?.lockScreen.changed() }
        model.liveActivity.onShow = { [weak self] in try self?.lockScreen.show() }
        // Opening a thread here is reading it: its notification goes.
        model.onOpenThread = { [weak self] threadId in self?.desk.clear(threadId: threadId, hostId: hostId) }
        model.outside.onAccessState = { [weak self] access in self?.accessState(access, hostId: hostId) }
        lockScreen.changed()
        if let link = pendingLink, link.hostId == nil || link.hostId == hostId { model.deepLink = link.threadId; pendingLink = nil }
        // Read once the runtime is starting, never before it: the permission's sync goes to that
        // runtime, and asking the system must not hold back a launch's first connection.
        Task { await refreshPermission() }
    }
    func detach(_ model: ClientModel) {
        guard let index = machines.firstIndex(where: { $0.model === model }) else { return }
        model.notificationSink = nil
        feeds.removeValue(forKey: machines[index].hostId)?.forEach { $0.finish(false) }
        machines[index].notifier.invalidate()
        withdrawBridgeAlerts(machines[index].hostId)
        machines.remove(at: index)
        model.liveActivity.onChange = nil
        model.liveActivity.onShow = nil
        model.onOpenThread = nil
        model.outside.onAccessState = nil
        lockScreen.changed()
    }
    /// A machine turned off on this phone: its notifications are withdrawn, its approvals leave
    /// the Live Activity, and the lock screen and widgets rebuild without it, not even "as of".
    func turnedOff(_ hostId: String) {
        // Alerts it already handed over don't land after the clear, whenever their task runs.
        for entry in machines where entry.hostId == hostId { entry.notifier.invalidate() }
        desk.clear(hostId: hostId)
        withdrawBridgeAlerts(hostId)
        approvals = approvals.filter { $0.value.hostId != hostId }
        approvalAlerts = approvalAlerts.filter { approvals[$0.value] != nil }
        if pendingLink?.hostId == hostId { pendingLink = nil }
        lockScreen.forgetHeld()
        lockScreen.rebuild()
    }
    func client(_ hostId: String?) -> ClientModel? {
        guard let hostId else { return model }
        return machines.first { $0.hostId == hostId }?.model
    }
    /// Patches from the machine with no host (tests, older callers) go to the first machine.
    func receive(_ patch: NotificationPatch) { receive(patch, from: machines.first?.hostId ?? "") }
    func receive(_ patch: NotificationPatch, from hostId: String) {
        let entry = machines.first { $0.hostId == hostId }
        switch patch {
        case .alert(let alert):
            note(alert, from: hostId)
            guard let entry else { return }
            // Handled means posted, already shown from a push, or not wanted on this phone. Only
            // then does the bridge ack it; a phone suspended before this point gets the push.
            let delivered = { _ = entry.model.notificationAction(["type": "notifications.delivered", "id": alert.id]) }
            guard delivering(hostId) else { return delivered() }
            Task {
                await entry.notifier.receive(alert)
                delivered()
            }
        case .limit(let alert):
            guard delivering(hostId), alert.delivery?.post != false else { return }
            post(.limit(alert, hostId: hostId), from: hostId)
        case .run(let alert):
            guard delivering(hostId), alert.delivery?.post != false else { return }
            post(.run(alert, hostId: hostId), from: hostId)
        case .feed(let cursor, let entries, let retracted):
            for alert in entries { note(alert, from: hostId) }
            forget(retracted, from: hostId)
            guard let ledger = entry?.notifier else { return }
            let posting = delivering(hostId)
            Task {
                // Off or not allowed: advance past what was missed without posting it later.
                await ledger.catchUp(cursor: cursor, entries: posting ? entries : [], retracted: retracted)
                feeds.removeValue(forKey: hostId)?.forEach { $0.finish(true) }
            }
        case .connected:
            if let entry {
                sync(entry.model, ledger: entry.notifier, hostId: entry.hostId)
                connectedForAccess(entry.model, hostId: entry.hostId)
            }
        case .config(let preferences): preferencesByMachine[hostId] = preferences
        case .action(let id, let outcome):
            if outcome == .saved { outcomes[id]?.latest = outcome } else { outcomes.removeValue(forKey: id)?.finish(outcome) }
        }
    }
    /// A usage-limit or run notification the bridge decided, remembered so it goes with its machine.
    private func post(_ content: AlertContent, from hostId: String) {
        var ids = bridgePosted[hostId, default: []].filter { $0 != content.identifier }
        ids.append(content.identifier)
        bridgePosted[hostId] = Array(ids.suffix(Self.bridgePostedLimit))
        defaults.set(bridgePosted, forKey: Keys.bridgePosted)
        desk.post(content)
    }
    /// A machine turned off or gone: its usage-limit and run notifications go too, even one still queued.
    func withdrawBridgeAlerts(_ hostId: String) {
        guard let ids = bridgePosted.removeValue(forKey: hostId), !ids.isEmpty else { return }
        defaults.set(bridgePosted, forKey: Keys.bridgePosted)
        desk.withdraw(ids.sorted())
    }
    var delivering: Bool { enabled && permission == .allowed }
    /// Alerts from this machine: on for the phone, allowed by iOS, and not muted for it.
    func delivering(_ hostId: String) -> Bool { delivering && !muted.contains(hostId) }

    /// Every machine's bridge reports presence and catches up whenever this changes or it connects.
    func sync() { for entry in machines { sync(entry.model, ledger: entry.notifier, hostId: entry.hostId) } }
    private func sync(_ model: ClientModel, ledger: LocalNotifier, hostId: String) {
        var action: [String: Any] = ["type": "notifications.sync", "enabled": delivering(hostId),
                                     "appState": foreground ? "foreground" : "background", "cursor": ledger.ledger.cursor]
        action["phone"] = phone.json
        // Only to a machine allowed to alert this phone; one turned off here learns no token.
        if let push, delivering(hostId) { action["push"] = push.json }
        model.notificationAction(action)
    }
    func scene(active: Bool) {
        guard foreground != active else { return }
        foreground = active
        lockScreen.foreground = active
        lockScreen.changed()
        sync()
        if !active, delivering { BackgroundRefresh.schedule() }
    }

    // MARK: Permission

    func refreshPermission() async {
        permission = await authorizer.status()
        askForPushToken()
        sync()
    }
    /// Asked once, after the first thread arrives from a paired machine; never on first launch.
    func askAfterFirstThread() async {
        guard machines.contains(where: { $0.model.connection == "ready" && $0.model.inboxLoaded && !$0.model.inbox.isEmpty }),
              !defaults.bool(forKey: Keys.asked) else { return }
        if permission == .unknown { permission = await authorizer.status() }
        guard permission == .notDetermined else { return }
        defaults.set(true, forKey: Keys.asked)
        await setEnabled(true)
    }
    func setEnabled(_ on: Bool) async {
        if on, permission == .notDetermined || permission == .unknown {
            permission = await authorizer.request() ? .allowed : await authorizer.status()
        }
        enabled = on && permission == .allowed
        defaults.set(enabled, forKey: Keys.enabled)
        askForPushToken()
        sync()
    }

    // MARK: Settings

    /// Ask every machine for its own preferences; each answer lands under its host.
    func loadPreferences() { for entry in machines { entry.model.notificationAction(["type": "notifications.config"]) } }
    /// What this machine last reported; the standard set until it answers.
    func preferences(for hostId: String) -> NotificationPreferences { preferencesByMachine[hostId] ?? .standard }
    /// Quiet hours belong to one machine: only that machine's daemon is told.
    func save(_ preferences: NotificationPreferences, for hostId: String) {
        guard let data = try? JSONEncoder().encode(preferences), let json = try? JSONSerialization.jsonObject(with: data),
              let entry = machines.first(where: { $0.hostId == hostId }) else { return }
        preferencesByMachine[hostId] = preferences
        entry.model.notificationAction(["type": "notifications.preferences", "preferences": json])
    }
    /// Turn one machine's alerts off or on for this phone; remembered across launches.
    func setMachine(_ hostId: String, enabled on: Bool) {
        if on { muted.remove(hostId) } else { muted.insert(hostId) }
        defaults.set(muted.sorted(), forKey: Keys.muted)
        if let entry = machines.first(where: { $0.hostId == hostId }) { sync(entry.model, ledger: entry.notifier, hostId: entry.hostId) }
    }
    /// Change this phone's own preferences; every machine's runtime applies them at once.
    func setPhone(_ next: PhoneNotificationPrefs) {
        guard next != phone else { return }
        phone = next
        next.save(defaults)
        sync()
    }
    /// The Live Activity on the Lock Screen and in the Dynamic Island; on unless turned off here.
    func setLiveActivity(_ on: Bool) {
        guard on != liveActivity else { return }
        liveActivity = on
        defaults.set(on, forKey: Keys.liveActivity)
        lockScreen.allowed = on
        lockScreen.rebuild()
    }
    func snoozes(for hostId: String) -> [String: Double] { snoozesByMachine[hostId] ?? [:] }
    func snooze(_ threadId: String, until: Double?, hostId: String? = nil) {
        let value = until ?? 0
        guard let host = hostId ?? machines.first?.hostId else { return }
        if client(host)?.notificationAction(["type": "notifications.snooze", "threadId": threadId, "until": Int(value)]) == true {
            snoozesByMachine[host, default: [:]][threadId] = until
        }
    }

    // MARK: Waiting on the bridge

    /// Register before sending, so a fast reply can't be missed.
    func expect(_ id: String, _ waiter: Waiter<NotificationPatch.ActionOutcome>) { outcomes[id] = waiter }
    func expectFeed(_ waiter: Waiter<Bool>, from hostId: String) { feeds[hostId, default: []].append(waiter) }
}

/// A one-shot result with a deadline. Main-actor only.
@MainActor final class Waiter<T: Sendable> {
    private var continuation: CheckedContinuation<T?, Never>?
    private var done = false
    private var result: T?
    var latest: T?
    func finish(_ value: T?) {
        guard !done else { return }
        done = true
        result = value
        continuation?.resume(returning: value)
        continuation = nil
    }
    func wait(_ timeout: Duration, sleep: @escaping @Sendable (Duration) async -> Void) async -> T? {
        let deadline = Task { @MainActor [weak self] in await sleep(timeout); self?.finish(nil) }
        defer { deadline.cancel() }
        return await withCheckedContinuation { continuation in
            if done { continuation.resume(returning: result) } else { self.continuation = continuation }
        }
    }
    static func wait(_ timeout: Duration, sleep: @escaping @Sendable (Duration) async -> Void, fallback: T,
                     register: (Waiter<T>) -> Void) async -> T {
        let waiter = Waiter<T>()
        register(waiter)
        return await waiter.wait(timeout, sleep: sleep) ?? fallback
    }
}
