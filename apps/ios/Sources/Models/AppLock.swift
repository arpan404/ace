import Foundation
import LocalAuthentication
import Observation

enum AuthenticationOutcome: Sendable, Equatable { case success, failed, unavailable }

/// Face ID, Touch ID or the device passcode. Injected so lock rules test without a device.
protocol Authenticator: Sendable {
    func authenticate(reason: String) async -> AuthenticationOutcome
}
struct DeviceOwnerAuthenticator: Authenticator {
    func authenticate(reason: String) async -> AuthenticationOutcome {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // Without a passcode the phone itself is unprotected; there is nothing to unlock with.
            return (error as? LAError)?.code == .passcodeNotSet ? .unavailable : .failed
        }
        do { return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) ? .success : .failed }
        catch { return .failed }
    }
}

/// Locked on launch, and again after the app stays in the background for `timeout`. The person's
/// choices (on/off, timeout) are remembered in `defaults`; turning the lock off asks for Face ID
/// or the passcode first, so an unlocked phone left on a desk can't drop it.
@MainActor @Observable final class AppLock {
    /// Settings › App lock offers these, in seconds; zero locks as soon as ace leaves the screen.
    static let timeouts: [TimeInterval] = [0, 60, 300, 900, 3600]
    private(set) var locked: Bool
    private(set) var authenticating = false
    private(set) var failed = false
    private(set) var enabled: Bool
    private(set) var timeout: TimeInterval
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let authenticator: any Authenticator
    @ObservationIgnored private let defaults: UserDefaults?
    @ObservationIgnored private var backgroundedAt: Date?
    private enum Keys { static let enabled = "ace.lock.enabled", timeout = "ace.lock.timeout" }

    init(enabled: Bool, timeout: TimeInterval = 60, now: @escaping () -> Date, authenticator: any Authenticator = DeviceOwnerAuthenticator(),
         defaults: UserDefaults? = nil) {
        self.now = now; self.authenticator = authenticator; self.defaults = defaults
        // A choice the person made wins over the paired-or-not default.
        let on = defaults?.object(forKey: Keys.enabled) as? Bool ?? enabled
        self.enabled = on
        self.timeout = (defaults?.object(forKey: Keys.timeout) as? Double).flatMap { Self.timeouts.contains($0) ? $0 : nil } ?? timeout
        locked = on
    }
    /// The first pairing turns the lock on, unless the person already turned it off.
    func enable() {
        guard defaults?.object(forKey: Keys.enabled) == nil else { return }
        enabled = true
    }
    /// On at once; off only after the device owner authenticates. Returns the resulting state.
    @discardableResult func setEnabled(_ on: Bool) async -> Bool {
        if !on, enabled {
            guard !authenticating else { return enabled }
            authenticating = true
            let outcome = await authenticator.authenticate(reason: "Turn off the app lock")
            authenticating = false
            guard outcome != .failed else { return enabled }
        }
        enabled = on
        if !on { locked = false }
        defaults?.set(on, forKey: Keys.enabled)
        return enabled
    }
    func setTimeout(_ seconds: TimeInterval) {
        guard Self.timeouts.contains(seconds) else { return }
        timeout = seconds
        defaults?.set(seconds, forKey: Keys.timeout)
    }
    func didEnterBackground() {
        if backgroundedAt == nil { backgroundedAt = now() }
    }
    func didBecomeActive() {
        defer { backgroundedAt = nil }
        guard enabled, !locked, let since = backgroundedAt else { return }
        if now().timeIntervalSince(since) >= timeout { locked = true; failed = false }
    }
    func unlock() async {
        guard locked, !authenticating else { return }
        authenticating = true
        defer { authenticating = false }
        switch await authenticator.authenticate(reason: "Unlock your paired machines") {
        case .success, .unavailable: locked = false; failed = false
        case .failed: failed = true
        }
    }
}
