import Foundation
import Darwin

public enum LockedUseSocketError: Error, Equatable {
    case pathTooLong, notASocket
    /// Another process is already listening at the path; it is never displaced.
    case inUse
    case system(Int32)
}

/// The connected peer's effective user from the kernel (`LOCAL_PEERCRED`), or nil when
/// the credentials cannot be read or have an unknown layout.
public func lockedUsePeerUserID(_ fd: Int32) -> uid_t? {
    var credentials = xucred()
    var size = socklen_t(MemoryLayout<xucred>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &credentials, &size) == 0,
          size == socklen_t(MemoryLayout<xucred>.size), credentials.cr_version == XUCRED_VERSION else { return nil }
    return credentials.cr_uid
}

/// The connected peer's process id as the kernel recorded it at connect (`LOCAL_PEERPID`).
public func lockedUsePeerProcessID(_ fd: Int32) -> pid_t? {
    var pid: pid_t = 0
    var size = socklen_t(MemoryLayout<pid_t>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0, size == socklen_t(MemoryLayout<pid_t>.size),
          pid > 0 else { return nil }
    return pid
}

/// The process that spawned this one, or nil once it has exited and launchd adopted us.
public func lockedUseSpawningParent() -> pid_t? {
    let parent = getppid()
    return parent > 1 ? parent : nil
}

/// Listens on a Unix socket for the ace daemon. The socket file is mode 0600, created by
/// this process and never taken over from a live listener. The kernel's peer credentials
/// must name this process's user and the peer process must be the one that spawned this
/// service, so another same-user process that learned the path (or squatted it first)
/// is closed before it can speak. Only one connection is served at a time, and it must
/// then complete the handshake (see `LockedUseDaemonLink`).
public final class LockedUseSocketServer: @unchecked Sendable {
    private let path: String
    private let queue: DispatchQueue
    private let expectedUserID: uid_t
    private let peerUserID: (Int32) -> uid_t?
    private let expectedPeerProcessID: () -> pid_t?
    private let peerProcessID: (Int32) -> pid_t?
    private var listenFD: Int32 = -1
    private var source: DispatchSourceRead?
    private var current: LockedUseServedConnection?
    private let makeConnection: (Int32) -> LockedUseServedConnection

    /// `connect` builds the connection for a peer descriptor whose user and process already
    /// matched. `peerUserID` and `peerProcessID` read the kernel-attested peer; the expected
    /// process is read at each accept, and nil (the spawning daemon is gone) refuses all.
    public init(path: String, queue: DispatchQueue, expectedUserID: uid_t = getuid(),
                peerUserID: @escaping (Int32) -> uid_t? = lockedUsePeerUserID,
                expectedPeerProcessID: @escaping () -> pid_t? = lockedUseSpawningParent,
                peerProcessID: @escaping (Int32) -> pid_t? = lockedUsePeerProcessID,
                connect: @escaping (Int32) -> LockedUseServedConnection) {
        self.path = path
        self.queue = queue
        self.expectedUserID = expectedUserID
        self.peerUserID = peerUserID
        self.expectedPeerProcessID = expectedPeerProcessID
        self.peerProcessID = peerProcessID
        self.makeConnection = connect
    }

    public func start() throws {
        guard var address = lockedUseSocketAddress(path) else { throw LockedUseSocketError.pathTooLong }
        var info = stat()
        if lstat(path, &info) == 0 {
            // Only replace a stale socket; never delete some other file at this path, and
            // never displace a live listener (a squatter, or another service).
            guard info.st_mode & S_IFMT == S_IFSOCK, info.st_uid == expectedUserID else { throw LockedUseSocketError.notASocket }
            guard !lockedUseSomeoneListens(&address) else { throw LockedUseSocketError.inUse }
            unlink(path)
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw LockedUseSocketError.system(errno) }
        // bind creates the path exclusively: if anyone recreated it since the unlink, this
        // fails with EADDRINUSE instead of sharing it.
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
        guard current == nil, let peer = peerUserID(fd), peer == expectedUserID,
              let parent = expectedPeerProcessID(), peerProcessID(fd) == parent else { Darwin.close(fd); return }
        let connection = makeConnection(fd)
        current = connection
        connection.start()
    }
}

/// A Unix socket address for `path`, or nil when the path does not fit.
func lockedUseSocketAddress(_ path: String) -> sockaddr_un? {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard !bytes.isEmpty, bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
        for (index, byte) in bytes.enumerated() { raw[index] = byte }
    }
    return address
}

/// Whether a process is accepting connections at `address` right now.
private func lockedUseSomeoneListens(_ address: inout sockaddr_un) -> Bool {
    let probe = socket(AF_UNIX, SOCK_STREAM, 0)
    guard probe >= 0 else { return true }
    defer { Darwin.close(probe) }
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    // Only a refused connection proves the socket is stale; anything else counts as live.
    return connected == 0 || errno != ECONNREFUSED
}
