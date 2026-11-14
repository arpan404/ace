import Foundation
import Observation

/// Outside apps on one machine (ADR 0122, `bridge/outside-clients.ts`): sign-ins waiting for the
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
        /// The verified domain, or "unverified".
        let domain: String
        let verified: Bool
        let matchCode: String
        let expiresAt: Double
        /// Where the code goes once approved ("Signs in to claude.ai"), or a warning when it goes
        /// to an app on the signing-in device; nil when the machine didn't say.
        let redirect: String?
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
    /// What became of the last tapped sign-in alert (`outside.open`); `n` counts taps.
    struct Opened: Codable, Sendable, Equatable {
        let n: Int
        let requestId: String
        /// Nil: the sheet opens on it. Otherwise why it can't, in words.
        let ended: String?
    }
    struct State: Codable, Sendable, Equatable {
        let access: [Access]
        let screen: [ScreenUse]
        var opened: Opened? = nil
        /// The machine said this over a live connection; false once it is gone, when nothing is known.
        var live: Bool? = nil
    }

    private(set) var access: [Access] = []
    private(set) var screen: [ScreenUse] = []
    /// Sign-ins the person put aside with "Not now"; they stay in Settings' reach until they end.
    var setAside: Set<String> = []
    /// The tapped sign-in, shown first while it waits.
    private(set) var focus: String?
    /// A tapped sign-in that had already ended, said once in place of its sheet.
    var ended: String?
    private var answeredTap = 0
    /// Every state the machine sends over a live connection, for the notifications naming sign-ins.
    @ObservationIgnored var onAccessState: ((_ access: [Access]) -> Void)?

    func apply(_ next: State) {
        let after = Set(next.access.map(\.requestId))
        if access != next.access { access = next.access }
        if screen != next.screen { screen = next.screen }
        setAside.formIntersection(after)
        if let focus, !after.contains(focus) { self.focus = nil }
        if let opened = next.opened, opened.n != answeredTap {
            answeredTap = opened.n
            if let words = opened.ended { ended = words } else {
                focus = opened.requestId
                setAside.remove(opened.requestId)
            }
        }
        if next.live ?? true { onAccessState?(next.access) }
    }
    func reset() { access = []; screen = []; setAside = []; focus = nil }
    /// The sign-in the sheet shows now, if any: the tapped one first.
    var asking: Access? {
        access.first { $0.requestId == focus && !setAside.contains($0.requestId) }
            ?? access.first { !setAside.contains($0.requestId) }
    }
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

/// Connect an app on one machine (`bridge/outside-addresses.ts`): each address an outside
/// client can use, then the command a terminal agent's person runs.
struct OutsideAddresses: Decodable, Sendable, Equatable {
    struct Row: Decodable, Sendable, Equatable, Identifiable {
        /// local, tailscale, relay or custom.
        let path: String
        let title: String
        /// What Copy copies; nil while it can't serve.
        let url: String?
        /// The address, why it can't serve, or Off; nil when the machine didn't say.
        let state: String?
        let problem: Bool
        let note: String?
        /// Its own switch; nil for paths without one.
        let on: Bool?
        /// Your own URL as saved.
        let ownUrl: String?
        var id: String { path }
    }
    let rows: [Row]
    let enroll: String
}

extension ClientModel {
    func connectedApps(machine: String) async throws -> ConnectedApps {
        let reply = try await service(outside(["op": "grants"], machine: machine), as: Reply<ConnectedApps>.self)
        guard let value = reply.value else { throw OutsideRefusal(message: reply.message ?? "\(machine) couldn't list connected apps.") }
        return value
    }
    func outsideAddresses(machine: String) async throws -> OutsideAddresses {
        let reply = try await service(outside(["op": "addresses"], machine: machine), as: Reply<OutsideAddresses>.self)
        guard let value = reply.value else { throw OutsideRefusal(message: reply.message ?? "Couldn't read its addresses.") }
        return value
    }
    func outsideProjects(machine: String) async -> [ConnectedApps.Project] {
        (try? await service(outside(["op": "projects"], machine: machine), as: Reply<ProjectList>.self))?.value?.projects ?? []
    }
    /// revoke, update, stopScreen, decide, setPath or setPublicUrl; nil when the machine took it, else the refusal in words.
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
