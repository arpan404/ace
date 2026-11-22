import CryptoKit
import Foundation
import Testing
@testable import Ace

/// A relayed socket's proof of the person's standing (ADR 0190 §3): signed only over the
/// challenge its own welcome set, its own Noise handshake hash and the person's grant.
@Suite struct AccountStandingProofTests {
    private let host = String(repeating: "H", count: 52)
    private let grant = "eyJ2IjoyfQ.c2lnbmF0dXJl"
    private func welcome(nonce: String? = "nonce-1", host: String? = nil) -> String {
        let challenge = nonce.map { #","standingNonce":"\#($0)","standingHost":"\#(host ?? self.host)""# } ?? ""
        return #"{"type":"welcome","protocolVersion":1,"hostId":"home"\#(challenge)}"#
    }
    private func decoded(_ base64url: String) throws -> Data {
        var text = base64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while text.count % 4 != 0 { text += "=" }
        return try #require(Data(base64Encoded: text))
    }

    @Test func theProofSignsThisSocketsChallengeBindingAndGrantWithTheRuntimesKey() throws {
        let key = DeviceStandingKey.make()
        let challenge = try #require(AccountStandingProof.challenge(welcome: welcome(), hostId: host))
        let binding = AccountStandingProof.binding(handshakeHash: Data(repeating: 0xAB, count: 32))
        let text = try #require(AccountStandingProof.message(challenge, binding: binding, grant: grant, key: key, requestId: "standing-1"))
        let message = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: String])
        #expect(message["type"] == "account.standing")
        #expect(message["requestId"] == "standing-1")
        #expect(message["grant"] == grant)
        let publicKey = try P256.Signing.PublicKey(x963Representation: try decoded(key.publicKey))
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: try decoded(try #require(message["proof"])))
        let signed = Data("ace-standing/v2\n\(host)\nnonce-1\n\(binding)\n\(grant)".utf8)
        #expect(publicKey.isValidSignature(signature, for: signed))
        // Over another socket's nonce or channel, the same signature verifies nothing.
        #expect(!publicKey.isValidSignature(signature, for: Data("ace-standing/v2\n\(host)\nnonce-2\n\(binding)\n\(grant)".utf8)))
        #expect(!publicKey.isValidSignature(signature, for: Data("ace-standing/v2\n\(host)\nnonce-1\nnone\n\(grant)".utf8)))
    }

    @Test func theBindingIsTheHandshakeHashAsTheDaemonEncodesIt() {
        // `encodeBase64url` on the daemon: no padding, URL-safe alphabet.
        #expect(AccountStandingProof.binding(handshakeHash: Data([0xFB, 0xFF, 0xBF])) == "-_-_")
        #expect(AccountStandingProof.binding(handshakeHash: Data([0x01])) == "AQ")
    }

    @Test func aWelcomeThatAsksForNoProofOrNamesAnotherHostSetsNoChallenge() {
        #expect(AccountStandingProof.challenge(welcome: welcome(nonce: nil), hostId: host) == nil)
        #expect(AccountStandingProof.challenge(welcome: welcome(host: String(repeating: "J", count: 52)), hostId: host) == nil)
        #expect(AccountStandingProof.challenge(welcome: #"{"type":"pong"}"#, hostId: host) == nil)
    }

    @Test func fieldsThatArentOneCanonicalLineAreNeverSigned() throws {
        let key = DeviceStandingKey.make()
        let challenge = try #require(AccountStandingProof.challenge(welcome: welcome(nonce: #"a\nb"#), hostId: host))
        #expect(AccountStandingProof.message(challenge, binding: "b", grant: grant, key: key, requestId: "r") == nil)
        let fine = try #require(AccountStandingProof.challenge(welcome: welcome(), hostId: host))
        #expect(AccountStandingProof.message(fine, binding: "b", grant: "a grant", key: key, requestId: "r") == nil)
        #expect(AccountStandingProof.message(fine, binding: "", grant: grant, key: key, requestId: "r") == nil)
        #expect(AccountStandingProof.message(fine, binding: "b", grant: String(repeating: "g", count: 2049), key: key, requestId: "r") == nil)
    }

    @Test func onlyTheAnswerToThisSocketsProofIsTheVerdict() {
        let ok = #"{"type":"account.standing.result","requestId":"standing-1","result":{"ok":true,"until":1}}"#
        let refused = #"{"type":"account.standing.result","requestId":"standing-1","result":{"ok":false,"code":"unauthorized","message":"No"}}"#
        let member = #"{"type":"account.standing.result","requestId":"standing-1","result":{"ok":true,"until":1,"member":{"org":"org_a"}}}"#
        let another = #"{"type":"account.standing.result","requestId":"script-2","result":{"ok":true,"until":1}}"#
        #expect(StandingVerdict.read(ok, requestId: "standing-1") == .proven)
        #expect(StandingVerdict.read(refused, requestId: "standing-1") == .missing)
        #expect(StandingVerdict.read(member, requestId: "standing-1") == .missing)
        #expect(StandingVerdict.read(another, requestId: "standing-1") == nil)
    }

    @Test func aProvenVerdictLapsesWhenTheDaemonSaysItsStandingEnds() throws {
        let ok = #"{"type":"account.standing.result","requestId":"standing-1","result":{"ok":true,"until":1700000300000}}"#
        let refused = #"{"type":"account.standing.result","requestId":"standing-1","result":{"ok":false,"code":"unauthorized","message":"No"}}"#
        let until = try #require(StandingVerdict.until(ok, requestId: "standing-1"))
        #expect(until == Date(timeIntervalSince1970: 1_700_000_300))
        #expect(StandingVerdict.until(refused, requestId: "standing-1") == nil)
        #expect(StandingVerdict.until(ok, requestId: "script-2") == nil)
        // The wait is what is left of the daemon's time, never negative.
        #expect(StandingVerdict.wait(until: until, now: Date(timeIntervalSince1970: 1_700_000_100)) == 200)
        #expect(StandingVerdict.wait(until: until, now: Date(timeIntervalSince1970: 1_700_000_400)) == 0)
    }

    @Test func aProofIsRenewedBeforeItsStandingEndsAndNeverLater() {
        // Within the usual interval: renewed on schedule.
        #expect(StandingVerdict.renewal(remaining: 300, interval: 240) == 240)
        // A grant that ends sooner is renewed before it does, with a lead.
        #expect(StandingVerdict.renewal(remaining: 100, interval: 240) == 100 - StandingVerdict.lead)
        #expect(StandingVerdict.renewal(remaining: 5, interval: 240) == 0)
    }
}
