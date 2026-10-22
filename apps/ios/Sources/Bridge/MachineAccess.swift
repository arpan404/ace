import Foundation

/// `@ace/client/machines` entry: non-secret metadata for one paired computer.
struct MachineEntry: Codable, Sendable, Identifiable, Equatable {
    struct Target: Codable, Sendable, Equatable { let kind: String; let url: String; let fingerprint: String? }
    struct Icon: Codable, Sendable, Equatable { let kind: String; let color: String? }
    let hostId: String
    let displayName: String
    let icon: Icon?
    let target: Target
    let deviceId: String
    var id: String { hostId }

    /// Keychain key shared with the SDK's `machineSecretKey`: a JSON array of host and device.
    var secretKey: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes // Match JSON.stringify.
        let data = (try? encoder.encode([hostId, deviceId])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
    /// Pinned WSS to the stored address. Nil for relay entries or entries without a valid pin.
    var connectionTarget: ConnectionTarget? {
        guard target.kind == "direct", let url = URL(string: target.url), url.scheme == "wss",
              let pin = target.fingerprint, PinnedTrust.isPin(pin) else { return nil }
        return ConnectionTarget(endpoint: url, hostId: hostId, deviceId: deviceId, pin: pin, secretKey: secretKey)
    }
}

struct ProblemNotice: Codable, Sendable, Equatable, Error {
    let code: String
    let message: String
    static let unknown = ProblemNotice(code: "unknown", message: "Couldn't complete the request. Try again.")
    static let cancelled = ProblemNotice(code: "cancelled", message: "Pairing was cancelled.")
}
struct AccessOutcome: Decodable, Sendable {
    struct Paired: Decodable, Sendable { let hostId: String; let scopes: [String] }
    let ok: Bool
    let machines: [MachineEntry]?
    let paired: Paired?
    let problem: ProblemNotice?
}

enum AccessRequest: Sendable {
    case list
    case remove(hostId: String)
    case rename(hostId: String, name: String)
    case pair(PairingLink, name: String)
}

/// Directory and pairing operations; the bridge implementation runs the shared SDK.
protocol MachineAccess: Sendable {
    func perform(_ request: AccessRequest) async -> Result<AccessOutcome, ProblemNotice>
}

/// One short-lived JavaScriptCore runtime per operation, sharing the client bundle.
struct BridgeMachineAccess: MachineAccess {
    let directoryURL: URL
    var secrets: any SecretStore = KeychainSecrets()

    func perform(_ request: AccessRequest) async -> Result<AccessOutcome, ProblemNotice> {
        let target: ConnectionTarget?
        let body: [String: String]
        switch request {
        case .list: target = nil; body = ["op": "list"]
        case .remove(let hostId): target = nil; body = ["op": "remove", "hostId": hostId]
        case .rename(let hostId, let name): target = nil; body = ["op": "rename", "hostId": hostId, "name": name]
        case .pair(let link, let name):
            target = .pairing(endpoint: link.socketURL, pin: link.fingerprint)
            body = ["op": "pair", "code": link.code, "name": name, "url": link.socketURL.absoluteString, "fingerprint": link.fingerprint]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return .failure(.unknown) }
        let once = Once()
        var services = HostServices(secrets: secrets, secretAccess: .directory, directoryURL: directoryURL)
        let outcome: Result<AccessOutcome, ProblemNotice> = await withCheckedContinuation { continuation in
            let finish: @Sendable (Result<AccessOutcome, ProblemNotice>) -> Void = { result in
                if once.claim() { continuation.resume(returning: result) }
            }
            services.result = { json in
                guard let value = try? JSONDecoder().decode(AccessOutcome.self, from: Data(json.utf8)) else { finish(.failure(.unknown)); return }
                finish(value.ok ? .success(value) : .failure(value.problem ?? .unknown))
            }
            // Listing follows machines that are already connecting: it never competes with their
            // runtimes for the CPU. Pairing, renaming and removing are what the person waits on.
            let priority: QualityOfService = if case .list = request { .utility } else { .userInitiated }
            let runtime = ClientRuntime(access: target, services: services, priority: priority, fail: { _ in finish(.failure(.unknown)) })
            once.runtime = runtime
            runtime.startAccess(String(decoding: data, as: UTF8.self))
        }
        await withCheckedContinuation { continuation in
            if let runtime = once.runtime { runtime.stop { continuation.resume() } } else { continuation.resume() }
        }
        return outcome
    }
}
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    var runtime: ClientRuntime?
    func claim() -> Bool { lock.withLock { if claimed { return false }; claimed = true; return true } }
}

extension ConnectionTarget {
    /// Pairing has no device yet: pinned transport only, no stored credential.
    static func pairing(endpoint: URL, pin: String) -> ConnectionTarget {
        ConnectionTarget(endpoint: endpoint, hostId: "pairing", deviceId: "pairing", pin: pin, credential: { throw HostError.unsupported })
    }
}
