import AppKit
import ApplicationServices

/// Decides which accessibility notifications mean "the UI is still changing". Spinners,
/// progress bars, players and clocks repeat the same notification from the same element
/// many times a second; counting those would make every settle wait its maximum.
struct CUSettleNoise {
    /// Notifications from one element repeated more than `burst` times within `windowNs`
    /// are noise until that element calms down.
    let burst: Int
    let windowNs: UInt64
    private var recent: [Key: [UInt64]] = [:]

    private struct Key: Hashable { let element: Int; let notification: String }

    /// Roles whose value changes on their own, never because of the agent's step.
    static let ambientRoles: Set<String> = ["AXProgressIndicator", "AXBusyIndicator", "AXLevelIndicator", "AXRelevanceIndicator"]

    init(burst: Int = 4, windowNs: UInt64 = 1_000_000_000) {
        self.burst = burst
        self.windowNs = windowNs
    }

    /// Whether this notification should restart the quiet interval.
    mutating func counts(element: Int, notification: String, role: String?, now: UInt64) -> Bool {
        if notification == "AXValueChanged", let role, Self.ambientRoles.contains(role) { return false }
        let key = Key(element: element, notification: notification)
        var times = (recent[key] ?? []).filter { now >= $0 && now - $0 < windowNs }
        times.append(now)
        recent[key] = times
        if recent.count > 512 { recent = recent.filter { $0.value.last.map { now >= $0 && now - $0 < windowNs } ?? false } }
        return times.count <= burst
    }
}

/// Waits until the app stops reporting UI changes: at least `minimumMs`, then `quietMs`
/// without a counted accessibility notification, never longer than `maximumMs` or the
/// request's remaining budget.
@MainActor final class CUSettler {
    /// The helper's own last change (an action), and the app's last counted notification.
    private var lastHelperChange = DispatchTime.now().uptimeNanoseconds
    private var lastAppChange: UInt64?
    private var observer: AXObserver?
    private let application: AXUIElement
    private var pending: [String]
    private var noise = CUSettleNoise()
    private var roles: [Int: String] = [:]
    private(set) var windowEvents = 0
    /// Every notification received and every change the helper made, noise included.
    private(set) var events: UInt64 = 0
    /// True once every notification is registered, so silence means no change.
    var observingEverything: Bool { observer != nil && pending.isEmpty }
    /// Told about every notification, for caches that a change on an element invalidates.
    var observed: ((AXUIElement, String) -> Void)?
    /// Uptime after which settling stops waiting, set per request so a long batch stays bounded.
    var deadline: UInt64?

    static let notifications = [
        "AXValueChanged", "AXUIElementDestroyed", "AXCreated", "AXFocusedUIElementChanged", "AXLayoutChanged",
        "AXTitleChanged", "AXSelectedChildrenChanged", "AXSelectedRowsChanged", "AXWindowCreated", "AXMenuOpened",
        "AXMenuClosed", "AXRowCountChanged", "AXSelectedTextChanged", "AXFocusedWindowChanged", "AXSheetCreated",
        "AXLoadComplete", "AXExpandedChanged", "AXMenuItemSelected",
    ]

    init(pid: pid_t, application: AXUIElement) {
        self.application = application
        pending = Self.notifications
        let callback: AXObserverCallback = { _, element, notification, refcon in
            guard let refcon else { return }
            let settler = Unmanaged<CUSettler>.fromOpaque(refcon).takeUnretainedValue()
            MainActor.assumeIsolated { settler.received(notification as String, from: element) }
        }
        var created: AXObserver?
        guard AXObserverCreate(pid, callback, &created) == .success, let created else { return }
        observer = created
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .defaultMode)
        register()
    }

    /// Registers each notification on its own; ones the app was not ready for are retried on
    /// the next settle, ones it does not support are dropped.
    private func register() {
        guard let observer, !pending.isEmpty else { return }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        pending = pending.filter { name in
            switch AXObserverAddNotification(observer, application, name as CFString, refcon) {
            case .success, .notificationAlreadyRegistered, .notificationUnsupported, .actionUnsupported: return false
            default: return true
            }
        }
    }

    private func received(_ notification: String, from element: AXUIElement) {
        events &+= 1
        observed?(element, notification)
        if notification == "AXWindowCreated" || notification == "AXSheetCreated" { windowEvents += 1 }
        let key = Int(bitPattern: UInt(CFHash(element)))
        var role: String?
        if notification == "AXValueChanged" {
            if let known = roles[key] { role = known }
            else {
                role = cuRole(element)
                if roles.count > 2_048 { roles.removeAll() }
                roles[key] = role
            }
        }
        let now = DispatchTime.now().uptimeNanoseconds
        if noise.counts(element: key, notification: notification, role: role, now: now) { lastAppChange = now }
    }

    func markChanged() {
        lastHelperChange = DispatchTime.now().uptimeNanoseconds
        events &+= 1
    }

    /// `respondedQuietMs` (default `quietMs`) is the quiet needed once the app has reacted to
    /// the helper's last change; see `CUSettleWindow`.
    func settle(minimumMs: UInt64 = 80, quietMs: UInt64 = 150, respondedQuietMs: UInt64? = nil, maximumMs: UInt64 = 2_000) async {
        register()
        let started = DispatchTime.now().uptimeNanoseconds
        var limit = started + maximumMs * 1_000_000
        if let deadline { limit = min(limit, max(deadline, started)) }
        let window = CUSettleWindow(started: started, minimumNs: minimumMs * 1_000_000, quietNs: quietMs * 1_000_000,
                                    respondedQuietNs: (respondedQuietMs ?? quietMs) * 1_000_000, limit: limit)
        while !window.settled(now: DispatchTime.now().uptimeNanoseconds, lastHelperChange: lastHelperChange, lastAppChange: lastAppChange) {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    /// Waits for the app's first window after a launch: wakes on AXWindowCreated, checks at
    /// least every 100 ms, and returns as soon as `present` says a window exists.
    func waitForWindow(timeoutMs: UInt64, present: () -> Bool) async -> Bool {
        let started = DispatchTime.now().uptimeNanoseconds
        var seenEvents = -1
        var lastCheck: UInt64 = 0
        while DispatchTime.now().uptimeNanoseconds - started < timeoutMs * 1_000_000 {
            register()
            let now = DispatchTime.now().uptimeNanoseconds
            if seenEvents != windowEvents || now - lastCheck >= 100_000_000 {
                seenEvents = windowEvents
                lastCheck = now
                if present() { return true }
            }
            try? await Task.sleep(nanoseconds: 15_000_000)
        }
        return present()
    }

    func close() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        observer = nil
    }
}
