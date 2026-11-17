import Foundation
import Testing
@testable import Ace

/// What the phone offers a relay for its first handshake message, and what each answer means
/// (ADR 0155 steps 1 and 3, docs/relay/README.md). The wire against real relays is in
/// `RelayShortcutLiveTests`.
@Suite struct RelayEarlyTests {
    private let first = Data((0..<32).map { UInt8($0) })

    @Test func theFullOfferCarriesTheFirstMessageBesideTheGrantAndTheEarlySubprotocol() {
        let offered = RelayEarly.protocols(grant: "g", first: first, offer: .inUpgrade)
        #expect(offered == ["ace.grant.g", "ace.v2", "ace.x1.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", "ace.early.1"])
        // 43 characters of unpadded base64url after the prefix.
        #expect(offered[2].count == 50)
    }

    @Test func everyOfferKeepsTheGrantSoAnOlderRelayStillHasSomethingToEcho() {
        for offer in [RelayShortcut.inUpgrade, .early, .none] {
            #expect(RelayEarly.protocols(grant: "g", first: first, offer: offer).first == "ace.grant.g")
        }
        #expect(RelayEarly.protocols(grant: "g", first: first, offer: .early) == ["ace.grant.g", "ace.early.1"])
        #expect(RelayEarly.protocols(grant: "g", first: first, offer: .none) == ["ace.grant.g"])
    }

    @Test func anEntryUsesTheUrlSafeAlphabetWithoutPadding() {
        let entry = RelayEarly.protocols(grant: "g", first: Data(repeating: 0xFF, count: 32), offer: .inUpgrade)[2]
        #expect(entry == "ace.x1." + String(repeating: "_", count: 42) + "8")
    }

    @Test func theEchoSaysWhenTheFirstMessageGoes() {
        #expect(RelayEarly.first(echoed: "ace.v2", offer: .inUpgrade) == .taken)
        #expect(RelayEarly.first(echoed: "ace.early.1", offer: .inUpgrade) == .now)
        #expect(RelayEarly.first(echoed: "ace.early.1", offer: .early) == .now)
        #expect(RelayEarly.first(echoed: "ace.grant.g", offer: .inUpgrade) == .afterMarker)
        #expect(RelayEarly.first(echoed: nil, offer: .inUpgrade) == .afterMarker)
    }

    @Test func anEchoOfAShortcutThePhoneDidNotOfferIsNotTakenAsPermission() {
        #expect(RelayEarly.first(echoed: "ace.v2", offer: .early) == .afterMarker)
        #expect(RelayEarly.first(echoed: "ace.v2", offer: .none) == .afterMarker)
        #expect(RelayEarly.first(echoed: "ace.early.1", offer: .none) == .afterMarker)
    }

    @Test func anUpgradeThatFailedWithTheMessageInItIsRetriedOnceWithoutIt() {
        #expect(RelayEarly.retry(after: .inUpgrade, upgraded: false, closeCode: nil) == .early)
        #expect(RelayEarly.retry(after: .early, upgraded: false, closeCode: nil) == nil)
        #expect(RelayEarly.retry(after: .inUpgrade, upgraded: true, closeCode: 1006) == nil)
    }

    @Test func aLostEarlyFrameIsRetriedOnceWithoutEitherShortcutAndThenNotAgain() {
        #expect(RelayEarly.retry(after: .inUpgrade, upgraded: true, closeCode: 4020) == RelayShortcut.none)
        #expect(RelayEarly.retry(after: .early, upgraded: true, closeCode: 4020) == RelayShortcut.none)
        #expect(RelayEarly.retry(after: .none, upgraded: true, closeCode: 4020) == nil)
    }

    @Test func aRelayAnswersReadinessWithEitherMarker() {
        #expect(RelayEarly.isMarker(Data([1])))
        #expect(RelayEarly.isMarker(Data([2])))
        #expect(!RelayEarly.isMarker(Data([3])))
        #expect(!RelayEarly.isMarker(Data([1, 1])))
    }
}
