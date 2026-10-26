import Foundation
import Darwin

public enum LockedUseSocketError: Error, Equatable { case pathTooLong, notASocket, system(Int32) }

/// The connected peer's effective user from the kernel (`LOCAL_PEERCRED`), or nil when
/// the credentials cannot be read or have an unknown layout.
public func lockedUsePeerUserID(_ fd: Int32) -> uid_t? {
    var credentials = xucred()
    var size = socklen_t(MemoryLayout<xucred>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &credentials, &size) == 0,
          size == socklen_t(MemoryLayout<xucred>.size), credentials.cr_version == XUCRED_VERSION else { return nil }
    return credentials.cr_uid
}

/// Listens on a Unix socket for the ace daemon. The socket file is mode 0600, the kernel's
/// peer credentials must name this process's user, and only one connection is served at a
/// time. The served connection then has to prove it is the daemon (see `LockedUseDaemonLink`).
public final class LockedUseSocketServer: @unchecked Sendable {
    private let path: String
    private let queue: DispatchQueue
    private let expectedUserID: uid_t
    private let peerUserID: (Int32) -> uid_t?
    private var listenFD: Int32 = -1
    private var source: DispatchSourceRead?
    private var current: LockedUseServedConnection?
    private let makeConnection: (Int32) -> LockedUseServedConnection

    /// `connect` builds the connection for a peer descriptor whose user already matched.
    /// `peerUserID` reads the kernel-attested peer user; tests substitute it.
    public init(path: String, queue: DispatchQueue, expectedUserID: uid_t = getuid(),
                peerUserID: @escaping (Int32) -> uid_t? = lockedUsePeerUserID,
                connect: @escaping (Int32) -> LockedUseServedConnection) {
        self.path = path
        self.queue = queue
        self.expectedUserID = expectedUserID
        self.peerUserID = peerUserID
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
            guard info.st_mode & S_IFMT == S_IFSOCK, info.st_uid == expectedUserID else { throw LockedUseSocketError.notASocket }
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
            current?.closeAsync()
            current = nil
        }
        unlink(path)
    }

    /// Called on `queue` when the served connection closes, so another daemon may connect.
    public func connectionClosed() { current = nil }

    private func acceptOne() {
        let fd = accept(listenFD, nil, nil)
        guard fd >= 0 else { return }
        guard current == nil, let peer = peerUserID(fd), peer == expectedUserID else { Darwin.close(fd); return }
        let connection = makeConnection(fd)
        current = connection
        connection.start()
    }
}
