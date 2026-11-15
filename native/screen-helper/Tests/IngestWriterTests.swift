import XCTest
import Darwin
@testable import ScreenHelper

/// A listening Unix socket standing in for ace-media's ingest, read on demand.
final class Listener {
    let path: String
    private let fd: Int32
    private(set) var connection: Int32 = -1
    init() throws {
        path = NSTemporaryDirectory() + "ingest-\(UUID().uuidString.prefix(8)).sock"
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        let socketFd = fd
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(socketFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, listen(fd, 1) == 0 else { throw HelperError("listen failed") }
    }
    func accept() { connection = Darwin.accept(fd, nil, nil) }
    /// Reads exactly `count` bytes, or until end of stream.
    func read(_ count: Int) -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while data.count < count {
            let got = Darwin.read(connection, &buffer, min(buffer.count, count - data.count))
            if got <= 0 { break }
            data.append(contentsOf: buffer[0..<got])
        }
        return data
    }
    /// Reads until the writer closes; returns what came, and whether the stream ended.
    func readToEnd() -> (Data, ended: Bool) {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let got = Darwin.read(connection, &buffer, buffer.count)
            if got == 0 { return (data, true) }
            if got < 0 { return (data, false) }
            data.append(contentsOf: buffer[0..<got])
        }
    }
    /// Ends the accepted connection, as ace-media dropping it.
    func drop() { if connection >= 0 { close(connection); connection = -1 } }
    deinit { if connection >= 0 { close(connection) }; close(fd); unlink(path) }
}

func waitFor(_ condition: () -> Bool, seconds: Double = 5) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while !condition() { if Date() > end { return false }; usleep(2_000) }
    return true
}


/// The end-of-source frame ace-media takes as a clean end: kind 4, an empty payload.
func isEndFrame(_ bytes: Data) -> Bool {
    let frame = [UInt8](bytes)
    return frame.count == 44 && frame[0..<4] == [0x41, 0x43, 0x45, 0x4d] && frame[5] == 4
        && frame[6] == 0 && frame[7] == 44 && frame[8..<12] == [0, 0, 0, 0]
}

final class IngestWriterTests: XCTestCase {
    private let token = Data(repeating: 7, count: 32)
    private let helloBytes = 44 + 32

    func testWrittenPayloadsAreFreedWhileLaterOnesAreStillQueued() throws {
        let listener = try Listener()
        let writer = try IngestWriter(path: listener.path, token: token, onClosed: {}, onKeyframe: {})
        listener.accept()
        let first = Data(repeating: 1, count: 1 << 20), second = Data(repeating: 2, count: 3 << 20)
        writer.write(first, keyframe: true)
        writer.write(second, keyframe: false)
        // ace-media reads the hello and the first unit, then stalls inside the second.
        XCTAssertEqual(listener.read(helloBytes + first.count).count, helloBytes + first.count)
        XCTAssertTrue(waitFor { writer.queued <= second.count })
        XCTAssertGreaterThan(writer.queued, 0)
        // Only what is still to be written is held: the first unit's bytes are gone.
        XCTAssertEqual(writer.held, writer.queued)
        _ = listener.read(second.count)
        XCTAssertTrue(waitFor { writer.held == 0 })
        writer.close()
    }

    func testFinishWritesEveryQueuedUnitThenClosesTheConnection() throws {
        let listener = try Listener()
        let writer = try IngestWriter(path: listener.path, token: token, onClosed: { XCTFail("a finish is no failure") }, onKeyframe: {})
        listener.accept()
        let units = (1...3).map { Data(repeating: UInt8($0), count: 600_000) }
        for unit in units { writer.write(unit, keyframe: true) }
        writer.finish()
        // Nothing new is taken once the switch has begun.
        XCTAssertFalse(writer.write(Data([9]), keyframe: true))
        let (received, ended) = listener.readToEnd()
        XCTAssertTrue(ended, "the connection closes after the last unit")
        XCTAssertEqual(received.count, helloBytes + units.reduce(0) { $0 + $1.count } + 44)
        let body = received.prefix(received.count - 44)
        XCTAssertEqual(body.suffix(units[2].count), units[2], "the last unit is written before the end")
        XCTAssertTrue(isEndFrame(received.suffix(44)), "a planned finish ends with an end frame: a clean end")
        XCTAssertTrue(waitFor { writer.isClosed })
    }
}
