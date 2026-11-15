import Foundation
import Testing
@testable import Ace

/// A media connection (ADR 0147 §4) as Swift opens it: the shared script names where, and Swift
/// holds it to the runtime's own trust rules.
@Suite struct MediaSocketTests {
    private let hostA = "A4IOPXUIEEM6GMLBBSWHEDA3CUUI64AG6CB4CALXPPRXWGPSVCRQ"
    private func paired() -> ConnectionTarget {
        ConnectionTarget(endpoint: URL(string: "wss://studio.local:4611/")!, hostId: "h", deviceId: "d",
                         pin: DaemonCertificate.pin, secretKey: "token-key")
    }

    @Test func theScriptOpensTheDaemonSocketOrAMediaConnectionByWhatItNames() {
        #expect(SocketOpening.parse("") == .daemon)
        #expect(SocketOpening.parse(#"{"media":{"url":"wss://studio.local:4612/media"}}"#)
            == .media(URL(string: "wss://studio.local:4612/media")))
        #expect(SocketOpening.parse(#"{"media":{}}"#) == .media(nil))
        for value in ["{", #"{"other":{}}"#, #"{"media":{"url":7}}"#, String(repeating: " ", count: 5000)] {
            #expect(SocketOpening.parse(value) == .invalid, "\(value.prefix(20))")
        }
    }

    @Test func aDirectMediaConnectionIsOnlyThisDaemonsPinnedWSSAtTheAddressGiven() throws {
        let target = paired()
        let media = try #require(target.media(at: URL(string: "wss://100.64.0.7:4612/media")!))
        #expect(media.endpoint.absoluteString == "wss://100.64.0.7:4612/media")
        #expect(media.pin == target.pin)
        // Plain WS off loopback, credentials, queries and fragments are refused.
        for refused in ["ws://studio.local:4612/media", "wss://user:pw@studio.local/media",
                        "wss://studio.local/media?ticket=x", "wss://studio.local/media#x", "https://studio.local/media"] {
            #expect(target.media(at: URL(string: refused)!) == nil, "\(refused)")
        }
    }

    @Test func aMachineOnTheRelayHasNoDirectMediaAddressAndAsksTheRelayForAMediaStream() throws {
        let route = RelayRoute(relayURL: URL(string: "wss://ace.example.com")!, hostId: hostA,
                               grants: AccountGrants { () async throws(AccountGrantError) -> AceGrant in throw .signedOut })
        let target = ConnectionTarget(relay: route, deviceId: "d")
        #expect(target.media(at: URL(string: "wss://studio.local:4612/media")!) == nil)
        #expect(route.clientURL(purpose: "media")?.absoluteString == "wss://ace.example.com/client?hostId=\(hostA)&purpose=media")
        // The daemon's own channels keep the plain address.
        #expect(route.clientURL?.absoluteString == "wss://ace.example.com/client?hostId=\(hostA)")
    }

    @Test func aRelayMediaHelloAsksForCreditButNeverForDeflate() throws {
        let hello = #"{"type":"hello","channel":"media","mediaTicket":"t","grant":"g"}"#
        let offered = try #require(try JSONSerialization.jsonObject(with: Data(RelaySocket.offering(hello).utf8)) as? [String: Any])
        #expect(offered["compression"] == nil)
        #expect(offered["flowControl"] as? [String] == ["credit"])
        #expect(offered["mediaTicket"] as? String == "t")
    }
}
