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

/// Locked on launch, and again after the app stays in the background for `timeout`.
@MainActor @Observable final class AppLock {
    private(set) var locked: Bool
    private(set) var authenticating = false
    private(set) var failed = false
    private(set) var enabled: Bool
    @ObservationIgnored private let timeout: TimeInterval
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let authenticator: any Authenticator
    @ObservationIgnored private var backgroundedAt: Date?

    init(enabled: Bool, timeout: TimeInterval = 60, now: @escaping () -> Date, authenticator: any Authenticator = DeviceOwnerAuthenticator()) {
        self.enabled = enabled; self.timeout = timeout; self.now = now; self.authenticator = authenticator
        locked = enabled
    }
    /// The first pairing turns the lock on for later launches and returns from background.
    func enable() { enabled = true }
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
