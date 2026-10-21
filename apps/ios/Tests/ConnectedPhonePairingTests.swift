import Foundation
import Testing
@testable import Ace

/// Explicit one-time renewal through the normal pairing API. No token is read or exported.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["ACE_IOS_RENEW_PAIRING"] == "1", "Opt-in pairing renewal on the connected phone"))
@MainActor struct ConnectedPhonePairingTests {
    @Test func renewThePhonesPairingWithItsOwnMachine() async throws {
        struct Link: Decodable { let url: String }
        let directory = try ProductionApp.storageDirectory()
        let input = directory.appendingPathComponent("verification-pairing.json")
        defer { try? FileManager.default.removeItem(at: input) }
        let link = try PairingLink.parse(JSONDecoder().decode(Link.self, from: Data(contentsOf: input)).url)
        let access = BridgeMachineAccess(directoryURL: ProductionApp.machineDirectory(in: directory))
        // Retire the revoked credential only. The old device's database/outbox stays on disk.
        if case .success(let directory) = await access.perform(.list),
           let old = directory.machines?.first(where: { $0.target.url == link.socketURL.absoluteString && $0.target.fingerprint == link.fingerprint }) {
            if case .failure(let notice) = await access.perform(.remove(hostId: old.hostId)) {
                Issue.record("Could not retire revoked pairing: \(notice.code)"); return
            }
        }
        let result = await access.perform(.pair(link, name: "iPhone"))
        switch result {
        case .success(let outcome): #expect(outcome.paired != nil)
        case .failure(let notice): Issue.record("Pairing renewal failed: \(notice.code)")
        }
    }
}
