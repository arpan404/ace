import XCTest
import Darwin
import LockedUseTransport

let secret = String(repeating: "0123456789abcdef", count: 4)
let daemonNonce = String(repeating: "11", count: 32)
let serviceNonce = [UInt8](repeating: 0x22, count: 32)
/// Known answers computed independently with `openssl dgst -sha256 -mac HMAC` over the
/// documented input, so the daemon's implementation can be checked against the same bytes.
let serviceProof = "5fad966f7fae77a4bac2e07f416011f9e3c02488b38c5e480c7dc5a6f82591af"
let daemonProof = "c8b899a76fb02ee15c341927d005dee22ffa31032b1bb4cd697b5285912c4a11"

final class HandshakeTests: XCTestCase {
    let token = LockedUseDaemonToken(hex: secret)!

    func wire(_ step: LockedUseHandshakeStep) throws -> String {
        switch step {
        case .send(let message), .accepted(let message), .rejected(let message):
            return String(decoding: try message.encoded(), as: UTF8.self)
        }
    }

    func step(_ handshake: inout LockedUseHandshake, _ text: String) -> LockedUseHandshakeStep {
        handshake.receive(Data(text.utf8))
    }

    func testOnlyA64CharacterLowercaseHexTokenIsAccepted() {
        XCTAssertNotNil(LockedUseDaemonToken(hex: secret))
        for bad in ["", String(secret.dropLast()), secret + "0", secret.uppercased(), String(secret.dropLast()) + "g"] {
            XCTAssertNil(LockedUseDaemonToken(hex: bad), bad)
        }
    }

    func testTheServiceProvesTheTokenFirstAndAcceptsTheDaemonsProofWithTheDocumentedFrames() throws {
        var handshake = LockedUseHandshake(token: token, serviceNonce: serviceNonce)
        let challenge = step(&handshake, #"{"v":1,"id":"h1","type":"hello","nonce":"\#(daemonNonce)"}"#)
        XCTAssertEqual(try wire(challenge),
            #"{"id":"h1","nonce":"\#(String(repeating: "22", count: 32))","ok":true,"proof":"\#(serviceProof)","type":"reply","v":1}"#)
        guard case .send = challenge else { return XCTFail("the hello alone must not authenticate") }
        XCTAssertFalse(handshake.authenticated)
        let accepted = step(&handshake, #"{"v":1,"id":"h2","type":"prove","proof":"\#(daemonProof)"}"#)
        XCTAssertEqual(try wire(accepted), #"{"id":"h2","ok":true,"type":"reply","v":1}"#)
        guard case .accepted = accepted else { return XCTFail("not accepted") }
        XCTAssertTrue(handshake.authenticated)
    }

    func testAHelloCarryingTheTokenItselfIsRefused() throws {
        var handshake = LockedUseHandshake(token: token, serviceNonce: serviceNonce)
        let result = step(&handshake, #"{"v":1,"id":"h1","type":"hello","nonce":"\#(daemonNonce)","token":"\#(secret)"}"#)
        guard case .rejected = result else { return XCTFail("a daemon that sends its token is not served") }
        XCTAssertTrue(try wire(result).contains(#""code":"unauthorized""#))
    }

    func testAProofForAnotherExchangeOrTheWrongRoleIsRefused() {
        // The service's own proof replayed back as the daemon's.
        var reflected = LockedUseHandshake(token: token, serviceNonce: serviceNonce)
        _ = step(&reflected, #"{"id":"h1","type":"hello","nonce":"\#(daemonNonce)"}"#)
        guard case .rejected = step(&reflected, #"{"id":"h2","type":"prove","proof":"\#(serviceProof)"}"#) else {
            return XCTFail("reflected proof accepted")
        }
        // A daemon proof recorded for one service nonce does not satisfy a fresh one.
        var fresh = LockedUseHandshake(token: token, serviceNonce: [UInt8](repeating: 0x33, count: 32))
        _ = step(&fresh, #"{"id":"h1","type":"hello","nonce":"\#(daemonNonce)"}"#)
        guard case .rejected = step(&fresh, #"{"id":"h2","type":"prove","proof":"\#(daemonProof)"}"#) else {
            return XCTFail("replayed proof accepted")
        }
        // The right exchange with a different token.
        var other = LockedUseHandshake(token: LockedUseDaemonToken(hex: String(secret.dropLast()) + "0")!, serviceNonce: serviceNonce)
        _ = step(&other, #"{"id":"h1","type":"hello","nonce":"\#(daemonNonce)"}"#)
        guard case .rejected = step(&other, #"{"id":"h2","type":"prove","proof":"\#(daemonProof)"}"#) else {
            return XCTFail("wrong token accepted")
        }
    }

    func testARejectedHandshakeNeverAcceptsAnythingAfterwards() {
        var handshake = LockedUseHandshake(token: token, serviceNonce: serviceNonce)
        _ = step(&handshake, #"{"id":"h1","type":"hello","nonce":"\#(daemonNonce)"}"#)
        _ = step(&handshake, #"{"id":"h2","type":"prove","proof":"\#(serviceProof)"}"#)
        guard case .rejected = step(&handshake, #"{"id":"h3","type":"prove","proof":"\#(daemonProof)"}"#) else {
            return XCTFail("a second try was allowed")
        }
        XCTAssertFalse(handshake.authenticated)
    }

    func testMalformedHellosAndEarlyRequestsAreRefused() throws {
        func first(_ text: String, nonce: [UInt8] = serviceNonce) -> LockedUseHandshakeStep {
            var handshake = LockedUseHandshake(token: token, serviceNonce: nonce)
            return step(&handshake, text)
        }
        let early = first(#"{"v":1,"id":"r2","type":"enable","optIn":true}"#)
        XCTAssertEqual(try wire(early), #"{"code":"unauthorized","message":"The first frame must be a hello with a fresh nonce, then a prove with the daemon's proof.","type":"error","v":1}"#)
        let rejected = [
            first("not json"),
            first(#"{"id":"h","type":"hello"}"#),
            first(#"{"id":"h","type":"hello","nonce":"\#(String(repeating: "AB", count: 32))"}"#),
            first(#"{"id":"h","type":"hello","nonce":"\#(daemonNonce.dropLast())"}"#),
            first(#"{"v":2,"id":"h","type":"hello","nonce":"\#(daemonNonce)"}"#),
            first(#"{"id":"h","type":"prove","proof":"\#(daemonProof)"}"#),
            first(#"{"id":"h","type":"hello","nonce":"\#(daemonNonce)"}"#, nonce: []),
            first(#"{"id":"h","type":"hello","nonce":"\#(String(repeating: "22", count: 32))"}"#),
        ]
        for (index, result) in rejected.enumerated() {
            guard case .rejected = result else { return XCTFail("case \(index) was not refused") }
        }
    }

    func testTheTokenIsReadFromItsLineOnStdin() throws {
        func read(_ bytes: String, closeAfter: Bool = true) -> LockedUseDaemonToken? {
            var fds: [Int32] = [0, 0]
            XCTAssertEqual(pipe(&fds), 0)
            defer { close(fds[0]) }
            _ = bytes.withCString { write(fds[1], $0, strlen($0)) }
            if closeAfter { close(fds[1]) }
            defer { if !closeAfter { close(fds[1]) } }
            return lockedUseReadDaemonToken(fd: fds[0], timeoutMilliseconds: 200)
        }
        let nonce = lockedUseDecodeHex32(daemonNonce)!
        func holds(_ token: LockedUseDaemonToken?) -> Bool {
            token?.verify(serviceProof, .service, peerNonce: nonce, ownNonce: serviceNonce) ?? false
        }
        XCTAssertTrue(holds(read(secret + "\n")))
        XCTAssertTrue(holds(read(secret + "\n{\"later\":1}", closeAfter: false)), "Bytes after the line are left")
        XCTAssertNil(read(secret), "No newline before EOF")
        XCTAssertNil(read(secret, closeAfter: false), "No newline before the deadline")
        XCTAssertNil(read("short\n"))
        XCTAssertNil(read(secret + secret + "\n"), "Overlong line")
    }
}
