import Foundation
import Darwin

/// Preserve one partially written packet and the newest packet per session, fairly queued.
final class FrameWriter {
    private let fd: Int32
    private let queue = DispatchQueue(label: "ace.screen.frames")
    private let lock = NSLock()
    private var current: Data?
    private var latest: [String: Data] = [:]
    private var order: [String] = []
    private var offset = 0
    private var closed = false
    private var suspended = true
    private let source: DispatchSourceWrite
    init(path: String) throws {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HelperError("Cannot create frame socket") }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            Darwin.close(fd); throw HelperError("Socket path exceeds limit")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: bytes) }
        let socketFd = fd
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(socketFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { Darwin.close(fd); throw HelperError("Cannot connect frame socket") }
        _ = fcntl(fd, F_SETFL, O_NONBLOCK)
        var enabled: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
        source = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.flush() }

    }
    func publish(_ packet: Data, sessionId: String = "legacy") {
        lock.lock()
        if !closed {
            if latest[sessionId] == nil { order.append(sessionId) }
            latest[sessionId] = packet
            if suspended { suspended = false; source.resume() }
        }
        lock.unlock()
    }
    func retire(_ sessionId: String) {
        lock.lock(); defer { lock.unlock() }
        latest.removeValue(forKey: sessionId); order.removeAll { $0 == sessionId }
    }
    private func flush() {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return }
        while true {
            if current == nil, !order.isEmpty { let id = order.removeFirst(); current = latest.removeValue(forKey: id); offset = 0 }
            guard let packet = current else { suspended = true; source.suspend(); return }
            let written = packet.withUnsafeBytes { buffer -> Int in
                guard let base = buffer.baseAddress else { return 0 }
                return Darwin.write(fd, base.advanced(by: offset), packet.count - offset)
            }
            if written < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK { return }
                exit(1)
            }
            if written == 0 { return }
            offset += written
            if offset == packet.count { current = nil }
        }
    }
    deinit { if suspended { source.resume() }; source.cancel(); Darwin.close(fd) }
}
