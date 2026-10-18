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
@MainActor @Observable final class NotificationCoordinator {
    enum Permission: Sendable { case unknown, notDetermined, denied, allowed }
    private enum Keys { static let enabled = "ace.notifications.enabled", asked = "ace.notifications.asked" }

    private(set) var enabled: Bool
    private(set) var permission: Permission = .unknown
    var preferences: NotificationPreferences = .standard
    /// Per-thread snoozes this phone set (`notification.snooze`), thread id → until (ms).
    private(set) var snoozes: [String: Double] = [:]
    @ObservationIgnored private(set) var model: ClientModel?
    @ObservationIgnored let notifier: LocalNotifier
    @ObservationIgnored private let authorizer: any NotificationAuthorizer
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored let now: () -> Double
    @ObservationIgnored private(set) var foreground = true
    @ObservationIgnored private var outcomes: [String: Waiter<NotificationPatch.ActionOutcome>] = [:]
    @ObservationIgnored private var feeds: [Waiter<Bool>] = []
    @ObservationIgnored let sleep: @Sendable (Duration) async -> Void
    @ObservationIgnored let makeId: () -> String
    /// Opens a short-lived connection when no UI connection exists (a background launch).
    @ObservationIgnored let connectInBackground: @MainActor (NotificationCoordinator) async -> ClientModel?
    @ObservationIgnored var transient: ClientModel?
    /// A tapped thread waiting for the UI connection of a cold launch.
    @ObservationIgnored var pendingLink: String?

    init(center: any NotificationCenterPort = SystemNotificationCenter(), authorizer: any NotificationAuthorizer = SystemAuthorizer(),
         defaults: UserDefaults = .standard, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
         sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
         makeId: @escaping () -> String = { UUID().uuidString.lowercased() },
         connectInBackground: @escaping @MainActor (NotificationCoordinator) async -> ClientModel? = BackgroundConnection.connect) {
        notifier = LocalNotifier(center: center)
        self.authorizer = authorizer; self.defaults = defaults; self.now = now; self.sleep = sleep
        self.makeId = makeId; self.connectInBackground = connectInBackground
        enabled = defaults.bool(forKey: Keys.enabled)
    }

    /// Call before `model.connect`: patches from that runtime reach this coordinator. A background
    /// connection for the same storage is closed first, so two runtimes never share it.
    func attach(_ model: ClientModel, target: ConnectionTarget) async {
        if let transient, transient !== model {
            self.transient = nil
            detach(transient)
            await transient.disconnectAndWait()
        }
        let scope = SHA256.hash(data: Data("\(target.hostId)\u{0}\(target.deviceId)".utf8)).map { String(format: "%02x", $0) }.joined()
        notifier.bind(LedgerStore(scope: scope, defaults: defaults))
        self.model = model
        model.notificationSink = { [weak self] patch in self?.receive(patch) }
        if let link = pendingLink { model.deepLink = link; pendingLink = nil }
        await refreshPermission()
    }
    func detach(_ model: ClientModel) {
        guard self.model === model else { return }
        model.notificationSink = nil
        self.model = nil
    }
    func receive(_ patch: NotificationPatch) {
        switch patch {
        case .alert(let alert):
            guard delivering else { return }
            Task { await notifier.receive(alert) }
        case .feed(let cursor, let entries, let retracted):
            Task {
                // Off or not allowed: advance past what was missed without posting it later.
                await notifier.catchUp(cursor: cursor, entries: delivering ? entries : [], retracted: retracted)
                for waiter in feeds { waiter.finish(true) }
                feeds.removeAll()
            }
        case .connected: sync()
        case .config(let preferences): self.preferences = preferences
        case .action(let id, let outcome):
            if outcome == .saved { outcomes[id]?.latest = outcome } else { outcomes.removeValue(forKey: id)?.finish(outcome) }
        }
    }
    var delivering: Bool { enabled && permission == .allowed }

    /// The bridge reports presence and catches up whenever this changes or a connection opens.
    func sync() {
        model?.notificationAction(["type": "notifications.sync", "enabled": delivering,
                                   "appState": foreground ? "foreground" : "background", "cursor": notifier.ledger.cursor])
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
        guard let model, model.connection == "ready", model.inboxLoaded, !model.inbox.isEmpty,
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

    func loadPreferences() { model?.notificationAction(["type": "notifications.config"]) }
    func save(_ preferences: NotificationPreferences) {
        guard let data = try? JSONEncoder().encode(preferences), let json = try? JSONSerialization.jsonObject(with: data) else { return }
        self.preferences = preferences
        model?.notificationAction(["type": "notifications.preferences", "preferences": json])
    }
    func snooze(_ threadId: String, until: Double?) {
        let value = until ?? 0
        if model?.notificationAction(["type": "notifications.snooze", "threadId": threadId, "until": Int(value)]) == true {
            snoozes[threadId] = until
        }
    }

    // MARK: Waiting on the bridge

    /// Register before sending, so a fast reply can't be missed.
    func expect(_ id: String, _ waiter: Waiter<NotificationPatch.ActionOutcome>) { outcomes[id] = waiter }
    func expectFeed(_ waiter: Waiter<Bool>) { feeds.append(waiter) }
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
