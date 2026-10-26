import XCTest
import Darwin
import LockedUseTransport

let secret = String(repeating: "0123456789abcdef", count: 4)

final class HandshakeTests: XCTestCase {
    let token = LockedUseDaemonToken(hex: secret)!

    func check(_ text: String) -> LockedUseHandshakeResult { lockedUseCheckHello(Data(text.utf8), token: token) }

    func wire(_ result: LockedUseHandshakeResult) throws -> String {
        switch result {
        case .accepted(let reply), .rejected(let reply): return String(decoding: try reply.encoded(), as: UTF8.self)
        }
    }

    func testOnlyA64CharacterLowercaseHexTokenIsAccepted() {
        XCTAssertNotNil(LockedUseDaemonToken(hex: secret))
        for bad in ["", String(secret.dropLast()), secret + "0", secret.uppercased(), String(secret.dropLast()) + "g"] {
            XCTAssertNil(LockedUseDaemonToken(hex: bad), bad)
        }
    }

    func testTheHelloWithTheDaemonsTokenIsAcceptedWithTheDocumentedReply() throws {
        let result = check(#"{"v":1,"id":"h1","type":"hello","token":"\#(secret)"}"#)
        XCTAssertEqual(try wire(result), #"{"id":"h1","ok":true,"type":"reply","v":1}"#)
        guard case .accepted = result else { return XCTFail("not accepted") }
        guard case .accepted = check(#"{"id":"h1","type":"hello","token":"\#(secret)"}"#) else { return XCTFail("v may be omitted") }
    }

    func testAWrongTokenIsRejectedWithTheDocumentedReply() throws {
        let wrong = String(secret.dropLast()) + "0"
        let result = check(#"{"v":1,"id":"h1","type":"hello","token":"\#(wrong)"}"#)
        guard case .rejected = result else { return XCTFail("accepted a wrong token") }
        XCTAssertEqual(try wire(result),
            #"{"error":{"code":"unauthorized","message":"The token does not match."},"id":"h1","ok":false,"type":"reply","v":1}"#)
        for token in ["", "1", #"\#(secret.uppercased())"#] {
            guard case .rejected = check(#"{"id":"h","type":"hello","token":"\#(token)"}"#) else { return XCTFail(token) }
        }
        guard case .rejected = check(#"{"id":"h","type":"hello","token":7}"#) else { return XCTFail("numeric token") }
        guard case .rejected = check(#"{"id":"h","type":"hello"}"#) else { return XCTFail("missing token") }
        guard case .rejected = check(#"{"v":2,"id":"h","type":"hello","token":"\#(secret)"}"#) else { return XCTFail("v2") }
    }

    func testARequestBeforeTheHelloIsRejectedEvenWithTheToken() throws {
        let result = check(#"{"v":1,"id":"r2","type":"enable","optIn":true,"token":"\#(secret)"}"#)
        guard case .rejected = result else { return XCTFail("served a request before hello") }
        XCTAssertEqual(try wire(result),
            #"{"code":"unauthorized","message":"The first frame must be a hello with the daemon's token.","type":"error","v":1}"#)
        guard case .rejected = check("not json") else { return XCTFail("garbage") }
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
        XCTAssertTrue(read(secret + "\n")?.matches(secret) ?? false)
        XCTAssertTrue(read(secret + "\n{\"later\":1}", closeAfter: false)?.matches(secret) ?? false, "Bytes after the line are left")
        XCTAssertNil(read(secret), "No newline before EOF")
        XCTAssertNil(read(secret, closeAfter: false), "No newline before the deadline")
        XCTAssertNil(read("short\n"))
        XCTAssertNil(read(secret + secret + "\n"), "Overlong line")
    }
}
