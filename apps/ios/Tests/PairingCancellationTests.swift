import Foundation
import Testing
@testable import Ace

struct PairingCancellationTests {
    @Test func cancelledPairingCannotSaveACredentialOrDirectory() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let secrets = MemorySecrets()
        var services = HostServices(secrets: secrets, secretAccess: .directory, directoryURL: root.appendingPathComponent("machines.json"))
        services.isCancelled = { true }
        let token = String(repeating: "c", count: 64)
        #expect(throws: CancellationError.self) {
            _ = try services.perform(HostRequest("secret.set", input: Data("{\"key\":\"device\",\"token\":\"\(token)\"}".utf8)))
        }
        #expect(try secrets.get("device") == nil)
        #expect(throws: CancellationError.self) {
            _ = try services.perform(HostRequest("directory.save", body: "{}"))
        }
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("machines.json").path))
    }
}
