import XCTest
import Darwin
import LockedUseTransport

final class SocketTests: XCTestCase {
    func pair() -> (Int32, Int32) {
        var fds: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
        return (fds[0], fds[1])
    }

    func testAnOversizedHeaderClosesTheConnection() {
        let (service, daemon) = pair()
        defer { close(daemon) }
        let closed = expectation(description: "closed")
        let connection = LockedUseFramedConnection(fd: service, queue: DispatchQueue(label: "c"),
            onFrame: { _ in XCTFail("No frame may be delivered") }, onClose: { closed.fulfill() })
        connection.start()
        var header: [UInt8] = [0x7f, 0xff, 0xff, 0xff]
        XCTAssertEqual(write(daemon, &header, 4), 4)
        wait(for: [closed], timeout: 5)
        var byte: UInt8 = 0
        XCTAssertEqual(read(daemon, &byte, 1), 0, "The service end was closed")
    }

    func testFramesRoundTripAndPeerCloseIsReported() throws {
        let (service, daemon) = pair()
        let got = expectation(description: "frame")
        let closed = expectation(description: "closed")
        let connection = LockedUseFramedConnection(fd: service, queue: DispatchQueue(label: "c"),
            onFrame: { XCTAssertEqual(String(decoding: $0, as: UTF8.self), "{\"id\":\"r\"}"); got.fulfill() },
            onClose: { closed.fulfill() })
        connection.start()
        let frame = try lockedUseEncodeFrame(Data("{\"id\":\"r\"}".utf8))
        _ = frame.withUnsafeBytes { write(daemon, $0.baseAddress, frame.count) }
        wait(for: [got], timeout: 5)
        connection.send(Data("{\"ok\":true}".utf8))
        var buffer = [UInt8](repeating: 0, count: 64)
        let count = read(daemon, &buffer, buffer.count)
        var decoder = LockedUseFrameDecoder()
        XCTAssertEqual(try decoder.append(Data(buffer.prefix(max(count, 0)))), [Data("{\"ok\":true}".utf8)])
        close(daemon)
        wait(for: [closed], timeout: 5)
    }

    func testTheServerNeverDeletesANonSocketFileAtItsPath() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lu-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("s").path
        FileManager.default.createFile(atPath: path, contents: Data("keep".utf8))
        let server = LockedUseSocketServer(path: path, queue: DispatchQueue(label: "s")) { fd in
            LockedUseFramedConnection(fd: fd, queue: DispatchQueue(label: "c"), onFrame: { _ in }, onClose: {})
        }
        XCTAssertThrowsError(try server.start()) { XCTAssertEqual($0 as? LockedUseSocketError, .notASocket) }
        XCTAssertEqual(FileManager.default.contents(atPath: path), Data("keep".utf8))
    }

    func testTheServerAcceptsOneSameUserDaemonAndOwnsItsSocketMode() throws {
        let directory = URL(fileURLWithPath: "/tmp").appendingPathComponent("lu-\(getpid())-\(UInt16.random(in: 0...UInt16.max))")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("s").path
        let got = expectation(description: "frame")
        let server = LockedUseSocketServer(path: path, queue: DispatchQueue(label: "s")) { fd in
            LockedUseFramedConnection(fd: fd, queue: DispatchQueue(label: "c"), onFrame: { _ in got.fulfill() }, onClose: {})
        }
        try server.start()
        defer { server.stop() }
        var info = stat()
        XCTAssertEqual(lstat(path, &info), 0)
        XCTAssertEqual(info.st_mode & 0o777, 0o600)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        defer { close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in for (i, b) in path.utf8.enumerated() { raw[i] = b } }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        XCTAssertEqual(connected, 0)
        let frame = try lockedUseEncodeFrame(Data("{}".utf8))
        _ = frame.withUnsafeBytes { write(fd, $0.baseAddress, frame.count) }
        wait(for: [got], timeout: 5)
    }
}
