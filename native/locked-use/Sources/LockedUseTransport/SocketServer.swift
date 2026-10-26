import Foundation
import Darwin

public enum LockedUseSocketError: Error, Equatable { case pathTooLong, notASocket, system(Int32) }

/// Listens on a Unix socket for the ace daemon. The socket file is mode 0600, a peer must
/// run as this process's user, and only one daemon connection is served at a time.
public final class LockedUseSocketServer: @unchecked Sendable {
    private let path: String
    private let queue: DispatchQueue
    private var listenFD: Int32 = -1
    private var source: DispatchSourceRead?
    private var current: LockedUseFramedConnection?
    private let makeConnection: (Int32) -> LockedUseFramedConnection

    /// `connect` builds the framed connection for an authenticated peer descriptor.
    public init(path: String, queue: DispatchQueue, connect: @escaping (Int32) -> LockedUseFramedConnection) {
        self.path = path
        self.queue = queue
        self.makeConnection = connect
    }

    public func start() throws {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { throw LockedUseSocketError.pathTooLong }
        var info = stat()
        if lstat(path, &info) == 0 {
            // Only replace a stale socket; never delete some other file at this path.
            guard info.st_mode & S_IFMT == S_IFSOCK, info.st_uid == getuid() else { throw LockedUseSocketError.notASocket }
            unlink(path)
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw LockedUseSocketError.system(errno) }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            for (index, byte) in bytes.enumerated() { raw[index] = byte }
        }
        let previous = umask(0o177)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        umask(previous)
        guard bound == 0, chmod(path, 0o600) == 0, listen(fd, 4) == 0 else {
            let error = errno
            Darwin.close(fd)
            throw LockedUseSocketError.system(error)
        }
        listenFD = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptOne() }
        source.setCancelHandler { Darwin.close(fd) }
        self.source = source
        source.resume()
    }

    public func stop() {
        queue.sync {
            source?.cancel()
            source = nil
            current?.close()
            current = nil
        }
        unlink(path)
    }

    /// Called on `queue` when the served connection closes, so another daemon may connect.
    public func connectionClosed() { current = nil }

    private func acceptOne() {
        let fd = accept(listenFD, nil, nil)
        guard fd >= 0 else { return }
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard current == nil, getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { Darwin.close(fd); return }
        let connection = makeConnection(fd)
        current = connection
        connection.start()
    }
}
