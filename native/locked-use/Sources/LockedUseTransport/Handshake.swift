import Foundation
import Darwin

/// The secret the ace daemon hands its own service at spawn: 32 random bytes written to the
/// service's stdin as 64 lowercase hex characters and a newline. It never appears in argv
/// or the environment, and it is held only in memory. A new one is made for every spawn.
public struct LockedUseDaemonToken: Sendable {
    private let bytes: [UInt8]

    /// Exactly 64 lowercase hex characters; anything else is refused, so a short or empty
    /// secret can never be accepted.
    public init?(hex: String) {
        guard let bytes = Self.decode(hex) else { return nil }
        self.bytes = bytes
    }

    /// Constant-time comparison: the time taken does not depend on where a guess differs.
    public func matches(_ candidate: String) -> Bool {
        guard let other = Self.decode(candidate) else { return false }
        var difference: UInt8 = 0
        for index in 0..<32 { difference |= bytes[index] ^ other[index] }
        return difference == 0
    }

    private static func decode(_ hex: String) -> [UInt8]? {
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

    private static func nibble(_ digit: UInt8) -> UInt8? {
        switch digit {
        case 0x30...0x39: return digit - 0x30
        case 0x61...0x66: return digit - 0x61 + 10
        default: return nil
        }
    }
}

/// What the service does with the first frame on a new connection.
public enum LockedUseHandshakeResult: Equatable, Sendable {
    /// The daemon proved it holds the token. Reply, then serve requests.
    case accepted(reply: LockedUseOutbound)
    /// Send this, then close the connection without serving anything.
    case rejected(LockedUseOutbound)
}

/// Pure check of the hello frame, which must be the first frame on every connection:
///
///     {"v":1,"id":"h1","type":"hello","token":"<64 lowercase hex>"}
///
/// Accepted:  {"id":"h1","ok":true,"type":"reply","v":1}
/// Rejected:  {"error":{"code":"unauthorized","message":"…"},"id":"h1","ok":false,"type":"reply","v":1}
/// No usable id, or the first frame is not a hello:
///            {"code":"unauthorized","message":"…","type":"error","v":1}
/// The connection closes after any rejection.
public func lockedUseCheckHello(_ frame: Data, token: LockedUseDaemonToken) -> LockedUseHandshakeResult {
    let denied = LockedUseWireError(code: "unauthorized", message: "The first frame must be a hello with the daemon's token.")
    guard let object = try? JSONSerialization.jsonObject(with: frame), let message = object as? [String: Any],
          message["type"] as? String == "hello" else { return .rejected(.error(denied, attemptID: nil)) }
    guard let id = message["id"] as? String, (1...64).contains(id.count),
          id.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
        return .rejected(.error(denied, attemptID: nil))
    }
    if let version = message["v"] {
        guard let number = version as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue == 1 else {
            return .rejected(.failure(id: id, LockedUseWireError(code: "unsupported", message: "Unsupported hello version")))
        }
    }
    guard let candidate = message["token"] as? String, token.matches(candidate) else {
        return .rejected(.failure(id: id, LockedUseWireError(code: "unauthorized", message: "The token does not match.")))
    }
    return .accepted(reply: .reply(id: id, status: nil))
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
