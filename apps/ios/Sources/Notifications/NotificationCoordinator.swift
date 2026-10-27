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
    }

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
    @ObservationIgnored private let center: any NotificationCenterPort
    @ObservationIgnored private let authorizer: any NotificationAuthorizer
    @ObservationIgnored private let defaults: UserDefaults
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

    init(center: any NotificationCenterPort = SystemNotificationCenter(), authorizer: any NotificationAuthorizer = SystemAuthorizer(),
         defaults: UserDefaults = .standard, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
         sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
         makeId: @escaping () -> String = { UUID().uuidString.lowercased() },
         connectInBackground: @escaping @MainActor (NotificationCoordinator) async -> [ClientModel] = BackgroundConnection.connect) {
        notifier = LocalNotifier(center: center)
        self.center = center
        self.authorizer = authorizer; self.defaults = defaults; self.now = now; self.sleep = sleep
        self.makeId = makeId; self.connectInBackground = connectInBackground
        enabled = defaults.bool(forKey: Keys.enabled)
        muted = Set(defaults.stringArray(forKey: Keys.muted) ?? [])
        phone = PhoneNotificationPrefs.load(defaults)
    }

    /// Call before `model.connect`: patches from that runtime reach this coordinator, bound to that
    /// machine's own ledger. Background connections still open are closed first, so two runtimes
    /// never share one machine's storage.
    func attach(_ model: ClientModel, target: ConnectionTarget) async {
        if transient.contains(where: { $0 !== model }) { await releaseTransient() }
        let scope = SHA256.hash(data: Data("\(target.hostId)\u{0}\(target.deviceId)".utf8)).map { String(format: "%02x", $0) }.joined()
        let ledger = LocalNotifier(center: center, hostId: target.hostId)
        ledger.bind(LedgerStore(scope: scope, defaults: defaults))
        machines.removeAll { $0.hostId == target.hostId || $0.model === model }
        machines.append((target.hostId, model, ledger))
        let hostId = target.hostId
        model.notificationSink = { [weak self] patch in self?.receive(patch, from: hostId) }
        if let link = pendingLink, link.hostId == nil || link.hostId == hostId { model.deepLink = link.threadId; pendingLink = nil }
        // Read once the runtime is starting, never before it: the permission's sync goes to that
        // runtime, and asking the system must not hold back a launch's first connection.
        Task { await refreshPermission() }
    }
    func detach(_ model: ClientModel) {
        guard let index = machines.firstIndex(where: { $0.model === model }) else { return }
        model.notificationSink = nil
        feeds.removeValue(forKey: machines[index].hostId)?.forEach { $0.finish(false) }
        machines.remove(at: index)
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
            guard delivering(hostId), let ledger = entry?.notifier else { return }
            Task { await ledger.receive(alert) }
        case .feed(let cursor, let entries, let retracted):
            guard let ledger = entry?.notifier else { return }
            let posting = delivering(hostId)
            Task {
                // Off or not allowed: advance past what was missed without posting it later.
                await ledger.catchUp(cursor: cursor, entries: posting ? entries : [], retracted: retracted)
                feeds.removeValue(forKey: hostId)?.forEach { $0.finish(true) }
            }
        case .connected: if let entry { sync(entry.model, ledger: entry.notifier, hostId: entry.hostId) }
        case .config(let preferences): preferencesByMachine[hostId] = preferences
        case .action(let id, let outcome):
            if outcome == .saved { outcomes[id]?.latest = outcome } else { outcomes.removeValue(forKey: id)?.finish(outcome) }
        }
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
        model.notificationAction(action)
    }
    func scene(active: Bool) {
        guard foreground != active else { return }
        foreground = active
        sync()
        if !active, delivering { BackgroundRefresh.schedule() }
    }

    // MARK: Permission

    func refreshPermission() async {
        permission = await authorizer.status()
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
