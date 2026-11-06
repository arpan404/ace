import Foundation
import Testing
@testable import Ace

/// One install id per app install (ADR 0115): the phone's device on every machine and account.
@Suite struct InstallIdentityTests {
    private final class Clock: @unchecked Sendable {
        var ms: Double = 1_730_851_200_123
        var made = 0
    }
    private func identity(_ keychain: MemorySecrets, _ defaults: UserDefaults, _ clock: Clock = Clock()) -> InstallIdentity {
        InstallIdentity(keychain: keychain, defaults: defaults, now: { clock.ms },
                        random: { clock.made += 1; return [UInt8](repeating: UInt8(clock.made), count: 10) })
    }
    private func defaults() throws -> UserDefaults { try #require(UserDefaults(suiteName: "ace.tests.\(UUID().uuidString)")) }

    @Test func signingOutAndInAgainKeepsOneInstallId() throws {
        let keychain = MemorySecrets(), defaults = try defaults(), clock = Clock()
        let install = identity(keychain, defaults, clock)
        let origin = try #require(URL(string: "https://ace.example.com"))
        let session = AceAccountSessionStore(origin: origin, secrets: MemorySecrets())
        try session.save("session-1")
        let first = session.deviceId(install: install)
        try session.clear()
        try session.save("session-2")
        #expect(session.deviceId(install: install) == first)
        // Another account origin (a switched account or backend) is the same device too.
        let other = AceAccountSessionStore(origin: try #require(URL(string: "https://staging.ace.example.com")), secrets: MemorySecrets())
        #expect(other.deviceId(install: install) == first)
        #expect(first == install.id())
        #expect(clock.made == 1)
        #expect(InstallIdentity.valid(first) == first)
        #expect(first.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil)
    }

    @Test func aReinstallKeepsTheIdTheKeychainHeld() throws {
        let keychain = MemorySecrets()
        let kept = identity(keychain, try defaults()).id()
        // A reinstall wipes UserDefaults; the Keychain item outlives it.
        let fresh = try defaults()
        #expect(identity(keychain, fresh).id() == kept)
        #expect(fresh.string(forKey: InstallIdentity.key) == kept)
        // A Keychain that lost its item takes the mirror back.
        let mirrored = try defaults()
        mirrored.set(kept, forKey: InstallIdentity.key)
        let emptied = MemorySecrets()
        #expect(identity(emptied, mirrored).id() == kept)
        #expect(try emptied.get(InstallIdentity.key) == kept)
    }

    @Test func theOldAccountDeviceIdBecomesTheInstallIdSoMachineCodePassesHold() throws {
        let defaults = try defaults(), clock = Clock()
        defaults.set("ios-0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", forKey: "ace.account.device.https://ace.example.com")
        let install = identity(MemorySecrets(), defaults, clock)
        #expect(install.id() == "ios-0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
        #expect(clock.made == 0)
        // A malformed stored value is never adopted.
        let broken = try self.defaults()
        broken.set("short", forKey: "ace.account.device.https://ace.example.com")
        #expect(identity(MemorySecrets(), broken).id() != "short")
    }

    @Test func thePhoneWritesUUIDv7sTheWayTheSharedClientDoes() {
        // Vectors from `uuidV7` in `@ace/client/install-id`.
        #expect(InstallIdentity.uuidV7(ms: Double(0x0190a8b27c3d), random: [0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9])
                == "0190a8b2-7c3d-7f01-8203-040506070809")
        #expect(InstallIdentity.uuidV7(ms: 1_730_851_200_123, random: [UInt8](repeating: 0, count: 10))
                == "0192fec5-5c7b-7000-8000-000000000000")
    }
}
