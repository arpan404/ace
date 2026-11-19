import Foundation
import Security

/// The immutable hint the authorization plug-in reads to bind a request to one attempt.
public let lockedUseAttemptHint = "dev.ace.locked-use.attempt"
public let lockedUseScreensaverRight = "system.login.screensaver"

/// Issues the unlock CANDIDATE request. Its result is never evidence that loginwindow
/// unlocked the desktop; only a separate session observation can establish that.
public protocol LockedUseUnlockRequesting: Sendable {
    func requestUnlock(attempt: String, completion: @escaping @Sendable (OSStatus) -> Void)
}

/// Requests `system.login.screensaver` through Authorization Services, carrying the attempt
/// id as an environment item. Whether the OS turns this into a real screen unlock is
/// unverified (see docs/research/macos-authorization-plugin-locked-use.md).
public struct LockedUseAuthorizationServicesUnlock: LockedUseUnlockRequesting {
    private let queue: DispatchQueue

    public init(queue: DispatchQueue = DispatchQueue(label: "dev.ace.locked-use.unlock-request")) { self.queue = queue }

    public func requestUnlock(attempt: String, completion: @escaping @Sendable (OSStatus) -> Void) {
        queue.async { completion(Self.copyRight(attempt: attempt)) }
    }

    private static func copyRight(attempt: String) -> OSStatus {
        var reference: AuthorizationRef?
        var status = AuthorizationCreate(nil, nil, [], &reference)
        guard status == errAuthorizationSuccess, let reference else { return status }
        defer { AuthorizationFree(reference, [.destroyRights]) }
        var hintValue = Array(attempt.utf8)
        status = lockedUseScreensaverRight.withCString { right in
            lockedUseAttemptHint.withCString { hintName in
                hintValue.withUnsafeMutableBytes { bytes in
                    var item = AuthorizationItem(name: right, valueLength: 0, value: nil, flags: 0)
                    var hint = AuthorizationItem(name: hintName, valueLength: bytes.count, value: bytes.baseAddress, flags: 0)
                    return withUnsafeMutablePointer(to: &item) { itemPointer in
                        withUnsafeMutablePointer(to: &hint) { hintPointer in
                            var rights = AuthorizationRights(count: 1, items: itemPointer)
                            var environment = AuthorizationEnvironment(count: 1, items: hintPointer)
                            // No interaction: a background request must never put up a password prompt.
                            return AuthorizationCopyRights(reference, &rights, &environment, [.extendRights], nil)
                        }
                    }
                }
            }
        }
        return status
    }
}
