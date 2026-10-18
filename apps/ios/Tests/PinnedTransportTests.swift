import Foundation
import Testing
@testable import Ace

@Suite struct PinnedTransportTests {
    private let during = Date(timeIntervalSince1970: 1_900_000_000)

    @Test func theDaemonsOwnPinVerifiesItsCertificate() throws {
        #expect(try CertificatePin.digest(certificate: DaemonCertificate.der) == DaemonCertificate.pin)
        try PinnedTrust.verify(certificate: DaemonCertificate.der, pin: DaemonCertificate.pin, now: during)
    }
    @Test func aChangedKeyIsRefused() {
        let other = String(DaemonCertificate.pin.reversed())
        #expect(throws: TrustFailure.mismatch) { try PinnedTrust.verify(certificate: DaemonCertificate.der, pin: other, now: during) }
        #expect(throws: TrustFailure.mismatch) { try PinnedTrust.verify(certificate: DaemonCertificate.der, pin: "", now: during) }
    }
    @Test func aCertificateOutsideItsValidityWindowIsRefusedEvenWithTheRightPin() throws {
        let window = try CertificatePin.validity(certificate: DaemonCertificate.der)
        #expect(window.lowerBound == DaemonCertificate.notBefore)
        #expect(window.upperBound == DaemonCertificate.notAfter)
        #expect(throws: TrustFailure.expired) {
            try PinnedTrust.verify(certificate: DaemonCertificate.der, pin: DaemonCertificate.pin, now: DaemonCertificate.notBefore.addingTimeInterval(-1))
        }
        #expect(throws: TrustFailure.expired) {
            try PinnedTrust.verify(certificate: DaemonCertificate.der, pin: DaemonCertificate.pin, now: DaemonCertificate.notAfter)
        }
    }
    @Test func malformedCertificatesAreRefused() {
        #expect(throws: TrustFailure.malformed) { try PinnedTrust.verify(certificate: Data([0x30, 0x03, 0x02, 0x01]), pin: DaemonCertificate.pin, now: during) }
        #expect(throws: TrustFailure.malformed) { try PinnedTrust.verify(certificate: DaemonCertificate.der.prefix(400), pin: DaemonCertificate.pin, now: during) }
    }
    @Test func theTokenTravelsOnlyInTheAuthorizationHeaderOfAFixedPath() throws {
        let origin = try #require(URL(string: "https://127.0.0.1:4611"))
        let token = String(repeating: "a", count: 64)
        let request = try PinnedHTTP.urlRequest(origin: origin, PinnedHTTPRequest(method: "POST", path: "/v1/tickets", body: nil, token: token), timeout: 15)
        #expect(request.url?.absoluteString == "https://127.0.0.1:4611/v1/tickets")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
        #expect(request.httpShouldHandleCookies == false)
        #expect(request.url?.absoluteString.contains(token) == false)
    }
    @Test func requestsOutsideTheAccessAPIOrWithInjectedHeadersAreRefused() throws {
        let origin = try #require(URL(string: "https://127.0.0.1:4611"))
        let refused = [
            PinnedHTTPRequest(method: "POST", path: "/pair", body: nil, token: nil),
            PinnedHTTPRequest(method: "POST", path: "/v1/../admin", body: nil, token: nil),
            PinnedHTTPRequest(method: "POST", path: "/v1/tickets?token=x", body: nil, token: nil),
            PinnedHTTPRequest(method: "DELETE", path: "/v1/devices/x", body: nil, token: nil),
            PinnedHTTPRequest(method: "POST", path: "/v1/tickets", body: nil, token: "x\r\nCookie: y"),
            PinnedHTTPRequest(method: "POST", path: "/v1/pair", body: String(repeating: "x", count: 5000), token: nil),
        ]
        for request in refused {
            #expect(throws: PinnedHTTPError.invalid, "\(request.path)") { _ = try PinnedHTTP.urlRequest(origin: origin, request, timeout: 15) }
        }
        let fragment = try #require(URL(string: "https://127.0.0.1:4611/#code=secret"))
        #expect(throws: PinnedHTTPError.invalid) {
            _ = try PinnedHTTP.urlRequest(origin: fragment, PinnedHTTPRequest(method: "POST", path: "/v1/pair", body: nil, token: nil), timeout: 15)
        }
    }
    @Test func theBridgeURLPolyfillExposesCredentialsQueriesAndFragmentsSoTheSDKCanRefuseThem() throws {
        let clean = try #require(ParsedURL.parse("wss://Studio.tail1234.ts.net:4243/"))
        #expect(clean.protocol == "wss:" && clean.hostname == "studio.tail1234.ts.net" && clean.port == "4243")
        #expect(clean.username.isEmpty && clean.search.isEmpty && clean.hash.isEmpty && clean.pathname == "/")
        let v6 = try #require(ParsedURL.parse("wss://[fd7a:115c::1]:443/"))
        #expect(v6.hostname == "[fd7a:115c::1]" && v6.port.isEmpty)
        let leaky = try #require(ParsedURL.parse("wss://user:pw@h:1/x?code=1#fingerprint=2"))
        #expect(leaky.username == "user" && leaky.password == "pw" && leaky.search == "?code=1" && leaky.hash == "#fingerprint=2")
        #expect(ParsedURL.parse("not a url") == nil)
    }
    @Test func pairedTargetsUseTheSameDaemonOverHTTPSAndRequireAPin() throws {
        let target = ConnectionTarget(endpoint: try #require(URL(string: "wss://100.64.0.7:4243/")), hostId: "h", deviceId: "d",
                                      pin: DaemonCertificate.pin, secretKey: "[\"h\",\"d\"]")
        #expect(target.httpsOrigin?.absoluteString == "https://100.64.0.7:4243")
        #expect(throws: Never.self) { try target.validate() }
        #expect(!target.isLoopbackFixture)
        let unpinned = ConnectionTarget(endpoint: try #require(URL(string: "ws://100.64.0.7:4243/")), hostId: "h", deviceId: "d",
                                        pin: DaemonCertificate.pin, secretKey: "k")
        #expect(throws: HostError.self) { try unpinned.validate() }
        let loopbackPaired = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:9841")), hostId: "h", deviceId: "d",
                                              pin: DaemonCertificate.pin, secretKey: "k")
        #expect(!loopbackPaired.isLoopbackFixture)
    }
}
