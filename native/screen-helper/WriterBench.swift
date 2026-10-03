import Foundation
import Darwin
struct HelperError: Error { init(_ message: String) {} }
@main struct WriterBenchmark {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("frames.sock").path
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { fatalError("Socket failed") }
        defer { Darwin.close(listener) }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8) + [0]) }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0, listen(listener, 1) == 0 else { fatalError("Listen failed") }
        let readerReady = DispatchSemaphore(value: 0)
        let releaseReader = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        let packetSize = 128 * 1024
        let operations = 100_000
        DispatchQueue.global().async {
            let fd = accept(listener, nil, nil)
            guard fd >= 0 else { fatalError("Accept failed") }
            defer { Darwin.close(fd) }
            readerReady.signal(); releaseReader.wait()
            var packet = Data(count: packetSize)
            var received = 0
            while true {
                var offset = 0
                while offset < packet.count {
                    let count = packet.withUnsafeMutableBytes { buffer -> Int in
                        guard let base = buffer.baseAddress else { return -1 }
                        return Darwin.read(fd, base.advanced(by: offset), packetSize - offset)
                    }
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { fatalError("Truncated packet") }
                    offset += count
                }
                received += 1
                let sequence = packet.withUnsafeBytes { UInt64(bigEndian: $0.loadUnaligned(as: UInt64.self)) }
                if sequence == operations { print("{\"persistedFrames\":\(received),\"receivedBytes\":\(received * packetSize)}"); finished.signal(); return }
            }
        }
        let writer = try FrameWriter(path: path)
        readerReady.wait()
        let packet = Data(count: packetSize)
        let start = CFAbsoluteTimeGetCurrent()
        for _ in 0..<operations { writer.publish(packet) }
        let elapsed = CFAbsoluteTimeGetCurrent() - start
        var final = packet
        var sequence = UInt64(operations).bigEndian
        withUnsafeBytes(of: &sequence) { final.replaceSubrange(0..<8, with: $0) }
        writer.publish(final)
        releaseReader.signal(); finished.wait()
        withExtendedLifetime(writer) {}
        var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
        print("{\"name\":\"native socket writer blocked-reader offers\",\"operations\":\(operations),\"opsPerSecond\":\(Int(Double(operations) / elapsed)),\"microsecondsPerOperation\":\(elapsed * 1_000_000 / Double(operations)),\"peakRssMiB\":\(Double(usage.ru_maxrss) / 1024 / 1024)}")
    }
}
