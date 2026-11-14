import Foundation

/// This phone's push address as each paired machine's `notifications.sync` carries it
/// (ADR 0106): the APNs token, which APNs environment issued it, and the public half of the
/// phone's push key. The bridge registers it with the machine and acknowledges live alerts.
struct PushRegistration: Equatable, Sendable {
    enum Environment: String, Sendable {
        case sandbox, production
        /// The environment the build's `aps-environment` entitlement names (`ACE_APS_ENVIRONMENT`
        /// in project.yml, through Info.plist): development is APNs' sandbox.
        static var current: Environment {
            switch Bundle.main.object(forInfoDictionaryKey: "AceAPSEnvironment") as? String {
            case "development": .sandbox
            case "production": .production
            default:
                #if DEBUG
                .sandbox
                #else
                .production
                #endif
            }
        }
    }
    /// Lowercase hex, whatever its length (Apple says not to assume one).
    let token: String
    let environment: Environment
    let p256dh: String
    let auth: String

    init(token: Data, environment: Environment, key: PushKey) {
        self.token = token.map { String(format: "%02x", $0) }.joined()
        self.environment = environment
        p256dh = key.p256dh
        auth = key.authSecret
    }
    var json: [String: String] { ["token": token, "environment": environment.rawValue, "p256dh": p256dh, "auth": auth] }
}

extension NotificationCoordinator {
    /// iOS gave a token (on every launch; it can change). A new one goes to every machine at once.
    func registeredForPush(_ registration: PushRegistration?) {
        guard registration != push else { return }
        push = registration
        sync()
    }
    /// Only once alerts are allowed; iOS answers through the app delegate. Without the push
    /// entitlement it fails there, quietly, and local alerts carry on as before.
    func askForPushToken() {
        if permission == .allowed { requestPushToken() }
    }
}
