import Foundation
import Observation

/// Outside apps on one machine (ADR 0117, `bridge/outside-clients.ts`): sign-ins waiting for the
/// person and apps using the screen now, as the bridge last said. The approval sheet and the
/// "Claude is using this Mac" line draw from it.
@MainActor @Observable final class OutsideClientsModel {
    struct ScopeChoice: Codable, Sendable, Equatable, Identifiable {
        let scope: String
        let label: String
        let note: String
        let on: Bool
        let fixed: Bool
        /// The app asked for it; nil in a grant's ticks.
        var asked: Bool? = nil
        var id: String { scope }
    }
    struct Expiry: Codable, Sendable, Equatable, Identifiable, Hashable { let id: String; let label: String }
    /// A sign-in waiting for the person.
    struct Access: Codable, Sendable, Equatable, Identifiable {
        let requestId: String
        let clientName: String
        /// The verified domain, or "Unverified".
        let domain: String
        let verified: Bool
        let matchCode: String
        let expiresAt: Double
        /// Set when an app that already has access asks for more.
        let grantId: String?
        let choices: [ScopeChoice]
        let expiries: [Expiry]
        /// The expiry picked to begin with (30 days).
        let expiry: String
        var id: String { requestId }
    }
    struct ScreenUse: Codable, Sendable, Equatable, Identifiable {
        let grantId: String
        let name: String
        let apps: [String]
        /// "Claude is using this Mac".
        let line: String
        var id: String { grantId }
    }
    struct State: Codable, Sendable, Equatable { let access: [Access]; let screen: [ScreenUse] }

    private(set) var access: [Access] = []
    private(set) var screen: [ScreenUse] = []
    /// Sign-ins the person put aside with "Not now"; they stay in Settings' reach until they end.
    var setAside: Set<String> = []

    func apply(_ next: State) {
        if access != next.access { access = next.access }
        if screen != next.screen { screen = next.screen }
        setAside.formIntersection(next.access.map(\.requestId))
    }
    func reset() { access = []; screen = []; setAside = [] }
    /// The sign-in the sheet shows now, if any.
    var asking: Access? { access.first { !setAside.contains($0.requestId) } }
}

/// One machine's connected apps, in the bridge's words (`answerOutside`).
struct ConnectedApps: Decodable, Sendable {
    struct Grant: Decodable, Sendable, Identifiable, Equatable {
        let id: String
        let name: String
        let domain: String
        let verified: Bool
        /// Pasted in from `ace mcp enroll` rather than signed in.
        let pasted: Bool
        /// active, expired or revoked.
        let state: String
        /// "Can read and start threads".
        let access: String
        let scopes: [String]
        let choices: [OutsideClientsModel.ScopeChoice]
        let projects: Projects
        let projectsLine: String
        let createdAt: Double
        let expiresAt: Double?
        let lastUsedAt: Double?
        let revokedAt: Double?
        let started: Int
        let messaged: Int
        var active: Bool { state == "active" }
    }
    /// Every project, or the chosen ones.
    enum Projects: Decodable, Sendable, Equatable {
        case all
        case chosen([String])
        init(from decoder: Decoder) throws {
            let box = try decoder.singleValueContainer()
            if let ids = try? box.decode([String].self) { self = .chosen(ids) } else { self = .all }
        }
    }
    struct Project: Decodable, Sendable, Identifiable, Hashable { let id: String; let name: String }
    let grants: [Grant]
    let projects: [Project]
    let expiries: [OutsideClientsModel.Expiry]
}

private struct ProjectList: Decodable, Sendable { let projects: [ConnectedApps.Project] }

extension ClientModel {
    func connectedApps(machine: String) async throws -> ConnectedApps {
        let reply = try await service(outside(["op": "grants"], machine: machine), as: Reply<ConnectedApps>.self)
        guard let value = reply.value else { throw OutsideRefusal(message: reply.message ?? "\(machine) couldn't list connected apps.") }
        return value
    }
    func outsideProjects(machine: String) async -> [ConnectedApps.Project] {
        (try? await service(outside(["op": "projects"], machine: machine), as: Reply<ProjectList>.self))?.value?.projects ?? []
    }
    /// revoke, update, stopScreen or decide; nil when the machine took it, else the refusal in words.
    func outsideChange(_ request: [String: Any], machine: String) async -> String? {
        do {
            let reply = try await service(outside(request, machine: machine), as: Reply<Empty>.self)
            return reply.ok ? nil : (reply.message ?? "\(machine) couldn't do that.")
        } catch { return error.localizedDescription }
    }
    private func outside(_ request: [String: Any], machine: String) -> [String: Any] {
        ["type": "native.outside", "machine": machine, "request": request]
    }
}

struct OutsideRefusal: LocalizedError { let message: String; var errorDescription: String? { message } }
private struct Empty: Decodable, Sendable {}
/// `{ ok: true, ... }` or `{ ok: false, message }`.
private struct Reply<T: Decodable & Sendable>: Decodable, Sendable {
    let ok: Bool
    let message: String?
    let value: T?
    private enum Keys: String, CodingKey { case ok, message }
    init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        ok = try box.decode(Bool.self, forKey: .ok)
        message = try box.decodeIfPresent(String.self, forKey: .message)
        value = ok ? try T(from: decoder) : nil
    }
}
