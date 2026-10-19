import Foundation
import Testing
@testable import Ace

@Suite struct PairingLinkTests {
    private let pin = "910f1d462b3420fa56b536af54a2a35082154ff832fcced8095103e34dc5eecc"
    private let code = "ef12265409b0b5a3daa4ba0a61fef08c3e1f281c54e5b094534ac0617aee3cae"

    @Test func aDaemonLinkYieldsAPinnedSocketAddressWithoutItsFragment() throws {
        // Copied from `POST /v1/pairings` on a real daemon.
        let link = try PairingLink.parse("  https://127.0.0.1:4611/pair#fingerprint=\(pin)&code=\(code)&scopes=read%2Coperate\n")
        #expect(link.socketURL.absoluteString == "wss://127.0.0.1:4611/")
        #expect(!link.socketURL.absoluteString.contains(code))
        #expect(link.socketURL.fragment == nil)
        #expect(link.code == code)
        #expect(link.fingerprint == pin)
        #expect(link.scopes == ["read", "operate"])
        #expect(link.accessSummary == "View and act")
        #expect(link.displayHost == "127.0.0.1:4611")
        #expect(link.fingerprintGroups.hasPrefix("910f 1d46 2b34"))
    }
    @Test func tailscaleIPv6AndHostnamesKeepTheirAuthority() throws {
        let v6 = try PairingLink.parse("https://[fd7a:115c:a1e0::1]:4243/pair#fingerprint=\(pin)&code=abc")
        #expect(v6.socketURL.absoluteString == "wss://[fd7a:115c:a1e0::1]:4243/")
        let named = try PairingLink.parse("https://studio.tail1234.ts.net/pair#code=abc&fingerprint=\(pin.uppercased())&scopes=read")
        #expect(named.socketURL.absoluteString == "wss://studio.tail1234.ts.net/")
        #expect(named.fingerprint == pin)
        #expect(named.accessSummary == "View only")
    }
    @Test func linksThatCannotBeVerifiedOrLeakCredentialsAreRefused() {
        let fragment = "#fingerprint=\(pin)&code=\(code)"
        let cases: [(String, PairingLinkError)] = [
            ("not a link", .notALink),
            ("http://127.0.0.1:4611/pair\(fragment)", .insecure),
            ("https://127.0.0.1:4611/pair?code=\(code)\(fragment)", .credentialsInURL),
            ("https://user:secret@127.0.0.1:4611/pair\(fragment)", .credentialsInURL),
            ("https://127.0.0.1:4611/connect\(fragment)", .wrongPath),
            ("https://127.0.0.1:4611/pair#fingerprint=\(pin)", .missingCode),
            ("https://127.0.0.1:4611/pair#code=\(code)", .invalidPin),
            ("https://127.0.0.1:4611/pair#code=\(code)&fingerprint=abc", .invalidPin),
        ]
        for (text, expected) in cases {
            #expect(throws: expected, "\(text)") { _ = try PairingLink.parse(text) }
        }
    }
}
