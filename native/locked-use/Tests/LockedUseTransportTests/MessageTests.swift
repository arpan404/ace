import XCTest
import LockedUseCore
import LockedUseTransport

final class MessageTests: XCTestCase {
    func decode(_ text: String) -> LockedUseInbound { lockedUseDecodeInbound(Data(text.utf8)) }

    func testBeginDecodesTheApprovedScopeAndIgnoresUnknownFields() throws {
        let inbound = decode("""
        {"v":1,"id":"r4","type":"begin","extra":{"x":[1]},"agentProcessIDs":[4242,4242],
         "scope":{"userID":501,"sessionID":100003,"threadID":"t","turnID":"u","attemptID":"a","future":true}}
        """)
        let scope = try LockedUseScope(userID: 501, sessionID: 100_003, threadID: "t", turnID: "u", attemptID: "a")
        XCTAssertEqual(inbound, .command(.begin(id: "r4", scope: scope, agentProcessIDs: [4242])))
    }

    func testMissingVersionReadsAsVersionOne() {
        XCTAssertEqual(decode(#"{"id":"r1","type":"status"}"#), .command(.status(id: "r1")))
        XCTAssertEqual(decode(#"{"id":"r5","type":"finish","attemptID":"a"}"#), .command(.finish(id: "r5", attemptID: "a")))
        XCTAssertEqual(decode(#"{"id":"r6","type":"cancel","attemptID":"a"}"#), .command(.cancel(id: "r6", attemptID: "a")))
    }

    func testUnknownTypesAndVersionsAreUnsupportedNotFatal() {
        XCTAssertEqual(decode(#"{"v":1,"id":"r","type":"teleport"}"#), .unsupported(id: "r", type: "teleport"))
        XCTAssertEqual(decode(#"{"v":2,"id":"r","type":"status"}"#), .unsupported(id: "r", type: "status"))
        XCTAssertEqual(decode(#"{"v":true,"id":"r","type":"status"}"#), .unsupported(id: "r", type: "status"))
    }

    func testMalformedInputIsRejectedWithTheIdWhenReadable() {
        XCTAssertEqual(decode("not json"), .malformed(id: nil, reason: "expected a JSON object"))
        XCTAssertEqual(decode("[1]"), .malformed(id: nil, reason: "expected a JSON object"))
        XCTAssertEqual(decode(#"{"type":"status"}"#), .malformed(id: nil, reason: "missing or invalid id"))
        XCTAssertEqual(decode(#"{"id":"","type":"status"}"#), .malformed(id: nil, reason: "missing or invalid id"))
        XCTAssertEqual(decode(#"{"id":"\#(String(repeating: "x", count: 65))","type":"status"}"#), .malformed(id: nil, reason: "missing or invalid id"))
        XCTAssertEqual(decode(#"{"id":"r"}"#), .malformed(id: "r", reason: "missing type"))
        XCTAssertEqual(decode(#"{"id":"r","type":"finish"}"#), .malformed(id: "r", reason: "missing attemptID"))
    }

    func testABeginWithAnInvalidScopeOrAgentListIsRejected() {
        let good = #""threadID":"t","turnID":"u","attemptID":"a""#
        XCTAssertEqual(decode(#"{"id":"r","type":"begin","scope":{"userID":0,"sessionID":1,\#(good)}}"#),
                       .malformed(id: "r", reason: "invalid scope"))
        XCTAssertEqual(decode(#"{"id":"r","type":"begin","scope":{"userID":501,"sessionID":1,"threadID":"","turnID":"u","attemptID":"a"}}"#),
                       .malformed(id: "r", reason: "invalid scope"))
        XCTAssertEqual(decode(#"{"id":"r","type":"begin"}"#), .malformed(id: "r", reason: "invalid scope"))
        for pids in ["[true]", "[-1]", "[1.5]", "[\"1\"]", "7", "[\(Array(repeating: "1", count: 65).joined(separator: ","))]"] {
            XCTAssertEqual(decode(#"{"id":"r","type":"begin","agentProcessIDs":\#(pids),"scope":{"userID":501,"sessionID":1,\#(good)}}"#),
                           .malformed(id: "r", reason: "invalid agentProcessIDs"), pids)
        }
    }

    func testOutboundMessagesUseTheDocumentedWireShapes() throws {
        func text(_ message: LockedUseOutbound) throws -> String { String(decoding: try message.encoded(), as: UTF8.self) }
        XCTAssertEqual(try text(.completion(attemptID: "a", threadID: "t", turnID: "u", reason: "finished", workError: nil)),
            #"{"attemptID":"a","reason":"finished","threadID":"t","turnID":"u","type":"completion","v":1,"workError":null}"#)
        XCTAssertEqual(try text(.failure(id: "r", LockedUseWireError(code: "not_locked", message: "m"))),
            #"{"error":{"code":"not_locked","message":"m"},"id":"r","ok":false,"type":"reply","v":1}"#)
        XCTAssertEqual(try text(.error(LockedUseWireError(code: "unlock_request_failed", message: "m"), attemptID: "a")),
            #"{"attemptID":"a","code":"unlock_request_failed","message":"m","type":"error","v":1}"#)
        let status = LockedUseStatus(phase: "ready", session: "locked", userID: 501, sessionID: 3, attemptID: nil,
            installation: .init(pluginSigned: true, ruleReachesMechanism: true, lockOnDisplaySleep: true,
                                brokerLinked: true, guardianLinked: true, verified: true))
        let reply = try JSONSerialization.jsonObject(with: try LockedUseOutbound.reply(id: "r", status: status).encoded()) as? [String: Any]
        XCTAssertEqual(reply?["ok"] as? Bool, true)
        XCTAssertEqual((reply?["status"] as? [String: Any])?["phase"] as? String, "ready")
    }
}
