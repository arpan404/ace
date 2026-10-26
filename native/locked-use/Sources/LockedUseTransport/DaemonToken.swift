import Foundation
import CryptoKit
import Security
import Darwin

/// Which side of the hello a proof speaks for. Each side's proof uses its own label, so a
/// proof one side produced can never be replayed as the other side's.
public enum LockedUseProofRole: Sendable {
    /// The service proves it holds the token: HMAC over the daemon's nonce, then its own.
    case service
    /// The daemon proves it holds the token: HMAC over the service's nonce, then its own.
    case daemon

    var label: String {
        switch self {
        case .service: return "ace-locked-use service proof"
        case .daemon: return "ace-locked-use daemon proof"
        }
    }
}

/// The secret the ace daemon hands its own service at spawn: 32 random bytes written to the
/// service's stdin as 64 lowercase hex characters and a newline. It never appears in argv
/// or the environment, never crosses the socket, and is held only in memory. A new one is
/// made for every spawn.
public struct LockedUseDaemonToken: Sendable {
    private let key: SymmetricKey

    /// Exactly 64 lowercase hex characters; anything else is refused, so a short or empty
    /// secret can never be accepted.
    public init?(hex: String) {
        guard let bytes = lockedUseDecodeHex32(hex) else { return nil }
        key = SymmetricKey(data: bytes)
    }

    /// HMAC-SHA256 keyed by the 32 token bytes over `label || 0x00 || first || second`,
    /// where `first` is the peer's nonce and `second` the prover's own (32 bytes each).
    public func proof(_ role: LockedUseProofRole, peerNonce: [UInt8], ownNonce: [UInt8]) -> [UInt8] {
        var message = Data(role.label.utf8)
        message.append(0)
        message.append(contentsOf: peerNonce)
        message.append(contentsOf: ownNonce)
        return Array(HMAC<SHA256>.authenticationCode(for: message, using: key))
    }

    /// Constant-time check of a hex proof: the time taken does not depend on where it differs.
    public func verify(_ hex: String, _ role: LockedUseProofRole, peerNonce: [UInt8], ownNonce: [UInt8]) -> Bool {
        guard let candidate = lockedUseDecodeHex32(hex) else { return false }
        let expected = proof(role, peerNonce: peerNonce, ownNonce: ownNonce)
        var difference: UInt8 = 0
        for index in 0..<32 { difference |= expected[index] ^ candidate[index] }
        return difference == 0
    }
}

/// Exactly 64 lowercase hex characters as 32 bytes, or nil.
public func lockedUseDecodeHex32(_ hex: String) -> [UInt8]? {
    let digits = Array(hex.utf8)
    guard digits.count == 64 else { return nil }
    var bytes = [UInt8]()
    bytes.reserveCapacity(32)
    for pair in stride(from: 0, to: 64, by: 2) {
        guard let high = nibble(digits[pair]), let low = nibble(digits[pair + 1]) else { return nil }
        bytes.append(high << 4 | low)
    }
    return bytes
}

public func lockedUseHex(_ bytes: [UInt8]) -> String {
    let digits = Array("0123456789abcdef".utf8)
    var out = [UInt8]()
    out.reserveCapacity(bytes.count * 2)
    for byte in bytes { out.append(digits[Int(byte >> 4)]); out.append(digits[Int(byte & 0x0f)]) }
    return String(decoding: out, as: UTF8.self)
}

private func nibble(_ digit: UInt8) -> UInt8? {
    switch digit {
    case 0x30...0x39: return digit - 0x30
    case 0x61...0x66: return digit - 0x61 + 10
    default: return nil
    }
}

/// 32 bytes from the system's cryptographic generator, or nil if it fails.
public func lockedUseRandomNonce() -> [UInt8]? {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
    return bytes
}

/// Reads the daemon's token line from `fd` (the service's stdin): 64 lowercase hex
/// characters then `\n`, within `timeoutMilliseconds`. Returns nil on timeout, EOF, a
/// malformed line or more than 65 bytes. Bytes after the newline are left unread.
public func lockedUseReadDaemonToken(fd: Int32, timeoutMilliseconds: Int32) -> LockedUseDaemonToken? {
    var line = [UInt8]()
    var remaining = timeoutMilliseconds
    while remaining > 0, line.count <= 65 {
        var request = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let started = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        let ready = poll(&request, 1, remaining)
        let spent = Int32(clamping: (clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - started) / 1_000_000)
        remaining -= max(spent, 1)
        if ready < 0, errno == EINTR { continue }
        guard ready > 0 else { return nil }
        var byte: UInt8 = 0
        let count = read(fd, &byte, 1)
        if count < 0, errno == EINTR || errno == EAGAIN { continue }
        guard count == 1 else { return nil }
        if byte == 0x0a { return LockedUseDaemonToken(hex: String(decoding: line, as: UTF8.self)) }
        line.append(byte)
    }
    return nil
}
