import Foundation

public enum LockedUseLockError: Error, Equatable { case failed(Int32) }

/// Starts an OS lock. Implementations must not synthesize input: the session's own input
/// guard suppresses events, and a relock must still work after that process has died.
/// Returning normally means the request was issued, never that the session is locked.
public protocol LockedUseLockSink: Sendable {
    func requestLock() throws
}

/// Runs a program and returns its exit status. Injected so tests never touch the Mac.
public typealias LockedUseSpawner = @Sendable (_ path: String, _ arguments: [String]) throws -> Int32

/// Puts the displays to sleep with `pmset displaysleepnow`. With the system's
/// "require password immediately" setting, display sleep locks the session; the
/// installation probe verifies that setting before the feature can be enabled.
/// Lock confirmation still comes only from an independent session observation.
public struct LockedUseDisplaySleepLock: LockedUseLockSink {
    private let spawn: LockedUseSpawner

    public init(spawn: @escaping LockedUseSpawner = lockedUseSpawnProcess) { self.spawn = spawn }

    public func requestLock() throws {
        let status = try spawn("/usr/bin/pmset", ["displaysleepnow"])
        guard status == 0 else { throw LockedUseLockError.failed(status) }
    }
}

/// Production spawner: no shell, fixed absolute path, waits for exit.
public let lockedUseSpawnProcess: LockedUseSpawner = { path, arguments in
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = arguments
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
}
