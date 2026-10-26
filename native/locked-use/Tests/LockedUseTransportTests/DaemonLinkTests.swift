import XCTest
import Darwin
import LockedUseTransport

/// A real socket pair: the service end runs `LockedUseDaemonLink`, the test plays the peer.
final class DaemonLinkTests: XCTestCase {
    final class Recorder: @unchecked Sendable {
        let lock = NSLock()
        var requests: [String] = []
        var closed: [Bool] = []
        func request(_ data: Data) { lock.lock(); requests.append(String(decoding: data, as: UTF8.self)); lock.unlock() }
        func close(_ authenticated: Bool) { lock.lock(); closed.append(authenticated); lock.unlock() }
        var snapshot: ([String], [Bool]) { lock.lock(); defer { lock.unlock() }; return (requests, closed) }
    }

    let queue = DispatchQueue(label: "link")
    let recorder = Recorder()
    var link: LockedUseDaemonLink?
    var timeouts: [() -> Void] = []

    /// Returns the peer's descriptor. The handshake deadline fires only when the test runs `timeouts`.
    func open(onAuthenticated: @escaping (LockedUseDaemonLink) -> Void = { _ in }) -> Int32 {
        var fds: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
        var wait = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(fds[1], SOL_SOCKET, SO_RCVTIMEO, &wait, socklen_t(MemoryLayout<timeval>.size))
        let recorder = recorder
        link = LockedUseDaemonLink(fd: fds[0], queue: queue, token: LockedUseDaemonToken(hex: secret)!, nonce: { serviceNonce },
            after: { [unowned self] _, queue, body in timeouts.append { queue.async(execute: body) } },
            onAuthenticated: onAuthenticated, onRequest: recorder.request, onClose: recorder.close)
        link?.start()
        return fds[1]
    }

    func write(_ fd: Int32, _ text: String) throws {
        let frame = try lockedUseEncodeFrame(Data(text.utf8))
        XCTAssertEqual(frame.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, frame.count) }, frame.count)
    }

    /// Everything the service sends until it closes (or 2 s pass), as decoded frames.
    func readAll(_ fd: Int32, frames expected: Int = .max) -> (frames: [String], closed: Bool) {
        var decoder = LockedUseFrameDecoder()
        var frames: [String] = []
        var buffer = [UInt8](repeating: 0, count: 4096)
        while frames.count < expected {
            let count = read(fd, &buffer, buffer.count)
            guard count > 0 else { return (frames, count == 0) }
            frames += ((try? decoder.append(Data(buffer.prefix(count)))) ?? []).map { String(decoding: $0, as: UTF8.self) }
        }
        return (frames, false)
    }

    let hello = #"{"v":1,"id":"h1","type":"hello","nonce":"\#(daemonNonce)"}"#
    let prove = #"{"v":1,"id":"h2","type":"prove","proof":"\#(daemonProof)"}"#

    func testAPeerThatProvesTheTokenIsServedAndItsCloseIsReportedAsTheDaemons() throws {
        let fd = open(onAuthenticated: { $0.send(Data(#"{"type":"state"}"#.utf8)) })
        try write(fd, hello)
        let challenge = readAll(fd, frames: 1).frames
        XCTAssertEqual(challenge.count, 1)
        XCTAssertTrue(challenge[0].contains(#""proof":"\#(serviceProof)""#), "The service proves itself before the daemon does")
        try write(fd, prove)
        try write(fd, #"{"v":1,"id":"r1","type":"status"}"#)
        XCTAssertEqual(readAll(fd, frames: 2).frames, [#"{"id":"h2","ok":true,"type":"reply","v":1}"#, #"{"type":"state"}"#])
        queue.sync {}
        XCTAssertEqual(recorder.snapshot.0, [#"{"v":1,"id":"r1","type":"status"}"#])
        close(fd)
        let closed = expectation(description: "closed")
        DispatchQueue.global().async { while self.recorder.snapshot.1.isEmpty { usleep(1000) }; closed.fulfill() }
        wait(for: [closed], timeout: 5)
        XCTAssertEqual(recorder.snapshot.1, [true])
    }

    func testAWrongProofIsRefusedClosedAndNeverServed() throws {
        let fd = open()
        defer { close(fd) }
        try write(fd, hello)
        try write(fd, #"{"v":1,"id":"h2","type":"prove","proof":"\#(serviceProof)"}"#)
        // Even the right proof afterwards gets no second chance on this connection.
        try write(fd, prove)
        try write(fd, #"{"v":1,"id":"r2","type":"enable","optIn":true}"#)
        let result = readAll(fd)
        XCTAssertTrue(result.closed)
        XCTAssertEqual(result.frames.count, 2)
        XCTAssertTrue(result.frames[1].contains(#""code":"unauthorized""#))
        queue.sync {}
        XCTAssertEqual(recorder.snapshot.0, [])
        XCTAssertEqual(recorder.snapshot.1, [false], "A refused peer is not the daemon; its close stops nothing")
    }

    func testARequestBeforeTheHelloClosesTheConnectionUnserved() throws {
        let fd = open()
        defer { close(fd) }
        try write(fd, #"{"v":1,"id":"r2","type":"enable","optIn":true}"#)
        let result = readAll(fd)
        XCTAssertTrue(result.closed)
        XCTAssertEqual(recorder.snapshot.0, [])
    }

    func testASilentPeerIsDroppedAtTheHandshakeDeadlineAndGetsNoState() throws {
        let fd = open()
        defer { close(fd) }
        link?.send(Data(#"{"type":"state"}"#.utf8))
        XCTAssertEqual(timeouts.count, 1)
        timeouts.forEach { $0() }
        let result = readAll(fd)
        XCTAssertTrue(result.closed)
        XCTAssertEqual(result.frames, [], "Nothing is sent before the hello")
        XCTAssertEqual(recorder.snapshot.1, [false])
    }

    func testTheDeadlineDoesNotDropAnAuthenticatedDaemon() throws {
        let fd = open()
        defer { close(fd) }
        try write(fd, hello)
        try write(fd, prove)
        XCTAssertEqual(readAll(fd, frames: 2).frames.count, 2)
        timeouts.forEach { $0() }
        queue.sync {}
        try write(fd, #"{"v":1,"id":"r1","type":"status"}"#)
        queue.sync {}
        let served = expectation(description: "served")
        DispatchQueue.global().async { while self.recorder.snapshot.0.isEmpty { usleep(1000) }; served.fulfill() }
        wait(for: [served], timeout: 5)
        XCTAssertEqual(recorder.snapshot.1, [])
    }
}
