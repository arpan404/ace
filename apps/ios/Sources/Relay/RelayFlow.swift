import Foundation

/// Credit-based flow control on a relayed channel (ADR 0110, docs/relay/README.md), the same
/// accounting as the daemon's `packages/secure-channel/src/flow-credit.ts`. ace's hosted relay
/// can't pause a socket, so without it the relay holds whatever the daemon sends a slow phone.
///
/// A credit fragment's plaintext is tag 7 and a 4-byte big-endian count of the peer's cost units
/// consumed. Each side sends at most `window` cost units its peer hasn't consumed; a fragment
/// costs its plaintext length, at least 4 KiB. A side's first credit says its own data is flow
/// controlled from there on. Pure: the socket owns sending, waiting and the cipher.
struct RelayFlow: Sendable {
    static let creditTag: UInt8 = 7
    static let window = 1024 * 1024
    private static let minimumCost = 4096
    /// Credit goes back once a quarter window is consumed, so a reader that keeps up never stalls.
    private static let creditStep = window / 4

    static func cost(_ plainLength: Int) -> Int { max(plainLength, minimumCost) }

    static func creditFragment(_ amount: Int) -> Data {
        var plain = Data([creditTag])
        withUnsafeBytes(of: UInt32(amount).bigEndian) { plain.append(contentsOf: $0) }
        return plain
    }
    /// The amount a credit fragment returns; nil when it isn't a well-formed credit.
    static func readCredit(_ plain: Data) -> Int? {
        guard plain.count == 5, plain.first == creditTag else { return nil }
        let amount = plain.dropFirst().reduce(0) { $0 << 8 | Int($1) }
        return amount <= window ? amount : nil
    }

    /// This side's sends are limited (it sent its start).
    private(set) var limited = false
    /// The peer's data is counted (its start arrived).
    private(set) var counting = false
    private var available = 0
    /// Data fragments received and not yet consumed, and how many of those predate counting.
    private var queued = 0
    private var uncounted = 0
    /// Counted cost received and not yet credited back.
    private var unacked = 0
    private var owed = 0

    /// Limit this side's sends from now on: the start fragment to send, the first time only.
    mutating func start() -> Data? {
        guard !limited else { return nil }
        limited = true
        available = Self.window
        return Self.creditFragment(0)
    }
    /// The peer returned `amount`. Its first credit starts counting what follows and limits
    /// this side too: the start fragment to send back, if this side hadn't started.
    mutating func credited(_ amount: Int) -> Data? {
        if !counting {
            counting = true
            uncounted = queued
        }
        let reply = start()
        available += amount
        return reply
    }
    func allows(_ cost: Int) -> Bool { !limited || available >= cost }
    mutating func spend(_ cost: Int) { if limited { available -= cost } }
    /// A data fragment arrived. False when the peer overran the window it was given.
    mutating func received(_ cost: Int) -> Bool {
        queued += 1
        guard counting else { return true }
        unacked += cost
        return unacked <= Self.window
    }
    /// The reader took a data fragment: a credit fragment to send, once enough is owed.
    mutating func consumed(_ cost: Int) -> Data? {
        queued -= 1
        if uncounted > 0 { uncounted -= 1; return nil }
        guard counting else { return nil }
        owed += cost
        guard owed >= Self.creditStep else { return nil }
        let credit = Self.creditFragment(owed)
        unacked -= owed
        owed = 0
        return credit
    }
}
