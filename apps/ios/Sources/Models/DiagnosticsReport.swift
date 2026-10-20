import Foundation

/// The diagnostics a person can share from Settings: app and OS versions, each machine's
/// connection and counts, and the phone's notification and lock choices. It carries no
/// credentials of any kind: no device tokens or tickets, no device ids, no addresses or
/// certificate pins, no thread titles or message text. Only codes and counts leave the phone.
struct DiagnosticsReport: Encodable, Equatable {
    struct App: Encodable, Equatable {
        let version: String
        let build: String
        let system: String
        let device: String
    }
    struct Machine: Encodable, Equatable {
        let name: String
        let hostId: String
        /// How it was paired ("lan", "tailscale"), never the address.
        let access: String?
        let connection: String
        let problem: String?
        let status: String?
        let aceVersion: String?
        let viewOnly: Bool
        let threads: Int
        let unsent: Int
        let tools: [String: String]
    }
    struct Notifications: Encodable, Equatable {
        let enabled: Bool
        let permission: String
        let mutedMachines: Int
    }
    struct Lock: Encodable, Equatable {
        let enabled: Bool
        let timeoutSeconds: Int
    }
    let generatedAt: String
    let app: App
    let machines: [Machine]
    let notifications: Notifications?
    let lock: Lock?

    @MainActor static func collect(app: App, inbox: MachineInbox, entries: [MachineEntry], notifications: NotificationCoordinator?,
                                   lock: AppLock?, now: Date) -> DiagnosticsReport {
        let machines = inbox.sessions.map { session in
            let client = session.client
            var tools: [String: String] = [:]
            for provider in client.providers?.providers ?? [] { tools[provider.name] = provider.status.label }
            return Machine(name: inbox.name(session.hostId), hostId: session.hostId,
                           access: entries.first { $0.hostId == session.hostId }?.target.kind,
                           connection: client.connection, problem: client.problem?.code, status: client.machineStatus?.status.label,
                           aceVersion: client.providers?.version, viewOnly: !client.canOperate,
                           threads: client.inbox.count, unsent: client.pending.values.filter { $0.state != "delivered" }.count, tools: tools)
        }
        let alerts = notifications.map { coordinator in
            Notifications(enabled: coordinator.enabled, permission: String(describing: coordinator.permission),
                          mutedMachines: coordinator.muted.count)
        }
        return DiagnosticsReport(generatedAt: now.ISO8601Format(), app: app, machines: machines, notifications: alerts,
                                 lock: lock.map { Lock(enabled: $0.enabled, timeoutSeconds: Int($0.timeout)) })
    }
    var json: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }
}

extension DiagnosticsReport.App {
    /// This build, read from the bundle and the device.
    @MainActor static var current: Self {
        let info = Bundle.main.infoDictionary
        let device = UIDeviceInfo.model
        return .init(version: info?["CFBundleShortVersionString"] as? String ?? "0",
                     build: info?["CFBundleVersion"] as? String ?? "0",
                     system: ProcessInfo.processInfo.operatingSystemVersionString, device: device)
    }
}

/// The hardware model identifier ("iPhone17,1"), which names no person.
enum UIDeviceInfo {
    static var model: String {
        var system = utsname()
        uname(&system)
        return withUnsafeBytes(of: &system.machine) { buffer in
            String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
}
