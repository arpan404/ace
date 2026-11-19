import Foundation
import Testing
@testable import Ace

struct PairingLifetimeTests {
    @Test func permissionFromAnEarlierAppearanceCannotStartCapture() {
        var lifetime = PairingLifetime()
        let first = lifetime.enter()
        #expect(lifetime.accepts(first))
        lifetime.leave()
        #expect(!lifetime.accepts(first))
        let second = lifetime.enter()
        #expect(!lifetime.accepts(first))
        #expect(lifetime.accepts(second))
    }

    @Test func phoneNameFitsTheBridgesUTF16LimitWithoutSplittingASurrogate() {
        #expect(pairingDeviceName(String(repeating: "😀", count: 256)) == String(repeating: "😀", count: 128))
        #expect(pairingDeviceName(String(repeating: "a", count: 255) + "😀") == String(repeating: "a", count: 255))
        #expect(pairingDeviceName("  My phone\n") == "My phone")
    }
}
