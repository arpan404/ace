import Foundation
import Testing
@testable import Ace

/// Real ace daemon over its TLS listener, started by `bun run e2e:pairing` (scripts/pairing-e2e.ts).
/// Skipped unless that script wrote its config; it never runs provider CLIs or spends quota.
private struct E2EConfig: Decodable {
    struct Admin: Decodable { let origin: String; let token: String }
    let hostId: String
    let links: [String: String]
    let admin: Admin
    let trapOrigin: String
    let closedOrigin: String
    static let path = "/tmp/ace-ios-pairing-e2e/config.json"
    static func load() -> E2EConfig? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? JSONDecoder().decode(E2EConfig.self, from: data)
    }
}

@Suite(.serialized, .enabled(if: E2EConfig.load() != nil, "Run scripts/pairing-e2e.ts first"))
@MainActor struct RealDaemonPairingTests {
    @Test(.timeLimit(.minutes(2))) func pairsConnectsReconnectsWithFreshTicketsAndReportsRevocation() async throws {
        let config = try #require(E2EConfig.load())
        let harness = try Harness()
        defer { harness.cleanUp() }
        await harness.machines.load()
        #expect(harness.machines.machines.isEmpty)
        let link = try PairingLink.parse(try #require(config.links["operate"]))
        try await expectPaired(harness, link, "ace iOS e2e")
        let entry = try #require(harness.machines.active)
        // The authenticated identity from the pinned socket, not the address's hostname.
        #expect(entry.hostId == config.hostId)
        #expect(entry.displayName.isEmpty == false)
        let client = harness.machines.client
        try await until("ready over pinned WSS") { client.connection == "ready" && client.inboxLoaded }
        #expect(!harness.machines.activeIsReadOnly)

        let token = try #require(try KeychainSecrets().get(entry.secretKey))
        #expect(token.count == 64)
        let directory = try String(contentsOf: harness.directoryFile, encoding: .utf8)
        #expect(!directory.contains(token) && !directory.contains(link.code))
        let database = ClientModel.database(hostId: entry.hostId, deviceId: entry.deviceId, in: harness.storage)
        #expect(FileManager.default.fileExists(atPath: database.path))

        // A redeemed code is single-use.
        #expect(await harness.machines.pair(link, name: "again")?.code == "expired")

        // Tickets are single-use, so every reconnect proves a fresh exchange over pinned HTTPS.
        for _ in 0..<2 {
            client.network(false)
            try await until("offline") { client.connection == "offline" && client.problem?.code == "offline" }
            client.network(true)
            try await until("ready again") { client.connection == "ready" && client.problem == nil }
        }

        try await revoke(entry.deviceId, config)
        try await until("revoked device is fatal") { client.connection == "fatal" && client.problem?.code == "revoked" }
        await harness.machines.remove(entry.hostId)
        #expect(try KeychainSecrets().get(entry.secretKey) == nil)
        #expect(!FileManager.default.fileExists(atPath: database.path))
    }

    @Test(.timeLimit(.minutes(1))) func aViewOnlyGrantConnectsAndIsShownAsViewOnly() async throws {
        let config = try #require(E2EConfig.load())
        let harness = try Harness()
        defer { harness.cleanUp() }
        await harness.machines.load()
        try await expectPaired(harness, try PairingLink.parse(try #require(config.links["read"])), "ace iOS read-only")
        try await until("ready") { harness.machines.client.connection == "ready" }
        #expect(harness.machines.activeIsReadOnly)
        if let entry = harness.machines.active { await harness.machines.remove(entry.hostId) }
    }

    @Test(.timeLimit(.minutes(1))) func aWrongPinSendsNothingSoTheSameCodeStillPairsWithTheRightPin() async throws {
        let config = try #require(E2EConfig.load())
        let harness = try Harness()
        defer { harness.cleanUp() }
        await harness.machines.load()
        let good = try PairingLink.parse(try #require(config.links["pin"]))
        let wrong = String(good.fingerprint.reversed())
        let tampered = try PairingLink.parse(try #require(config.links["pin"]).replacingOccurrences(of: good.fingerprint, with: wrong))
        #expect(await harness.machines.pair(tampered, name: "wrong pin")?.code == "pin")
        #expect(harness.machines.machines.isEmpty)
        try await expectPaired(harness, good, "right pin")
        if let entry = harness.machines.active { await harness.machines.remove(entry.hostId) }
    }

    @Test(.timeLimit(.minutes(1))) func aRedirectIsRefusedSoTheCodeIsNeverForwarded() async throws {
        let config = try #require(E2EConfig.load())
        let harness = try Harness()
        defer { harness.cleanUp() }
        await harness.machines.load()
        let real = try #require(config.links["redirect"])
        let trap = try #require(URL(string: config.trapOrigin))
        let viaTrap = real.replacingOccurrences(of: "127.0.0.1:4611", with: "\(trap.host ?? ""):\(trap.port ?? 0)")
        // The trap holds the daemon's own TLS key, so the pin passes and only the redirect is tested.
        #expect(await harness.machines.pair(try PairingLink.parse(viaTrap), name: "redirect")?.code == "redirect")
        try await expectPaired(harness, try PairingLink.parse(real), "after redirect")
        if let entry = harness.machines.active { await harness.machines.remove(entry.hostId) }
    }

    @Test(.timeLimit(.minutes(1))) func anUnreachableComputerIsReportedWithoutStoringAnything() async throws {
        let config = try #require(E2EConfig.load())
        let harness = try Harness()
        defer { harness.cleanUp() }
        await harness.machines.load()
        let closed = try #require(URL(string: config.closedOrigin))
        let link = try PairingLink.parse("https://\(closed.host ?? ""):\(closed.port ?? 0)/pair#fingerprint=\(DaemonCertificate.pin)&code=abc")
        #expect(await harness.machines.pair(link, name: "nobody")?.code == "unreachable")
        #expect(harness.machines.machines.isEmpty)
    }

    private func expectPaired(_ harness: Harness, _ link: PairingLink, _ name: String) async throws {
        let problem = await harness.machines.pair(link, name: name)
        #expect(problem == nil, "\(problem?.code ?? ""): \(problem?.message ?? "")")
        if problem != nil { throw HostError.transport }
    }
    private func revoke(_ deviceId: String, _ config: E2EConfig) async throws {
        var request = URLRequest(url: try #require(URL(string: "\(config.admin.origin)/v1/devices/\(deviceId)")))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(config.admin.token)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await URLSession.shared.data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
    }
    private func until(_ label: String, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(20)
        while !condition() {
            guard Date() < deadline else { Issue.record("Timed out: \(label)"); throw HostError.transport }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
}

@MainActor private struct Harness {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let suite = "ace.e2e.\(UUID().uuidString)"
    let machines: MachinesModel
    var directoryFile: URL { root.appendingPathComponent("machines.json") }
    var storage: URL { root.appendingPathComponent("machines", isDirectory: true) }
    init() throws {
        let defaults = try #require(UserDefaults(suiteName: suite))
        machines = MachinesModel(client: ClientModel(now: { Date().timeIntervalSince1970 * 1000 }),
                                 access: BridgeMachineAccess(directoryURL: root.appendingPathComponent("machines.json")),
                                 storage: root.appendingPathComponent("machines", isDirectory: true), defaults: defaults, itemLimit: 200)
    }
    func cleanUp() {
        let client = machines.client
        Task { await client.disconnectAndWait() }
        UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: root)
    }
}
