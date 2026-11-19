import Foundation
import Darwin
import Security

/// The two facts the ancestry check needs about one live process.
public struct LockedUseProcessFacts: Equatable, Sendable {
    public let parent: Int32
    /// Start time in microseconds; tells a recycled pid apart from the process it replaced.
    public let started: UInt64

    public init(parent: Int32, started: UInt64) {
        self.parent = parent
        self.started = started
    }
}

/// Whether `child` was spawned by a process that `trusted` accepts, and still is. The facts
/// are read before and after the (slow) trust check: the child's parent and both start
/// times must not change in between. A parent that exits makes launchd adopt the child, so
/// a recycled parent pid cannot stand in for the real one. An orphan (parent 1) is refused.
public func lockedUseVetAncestry(child: Int32, read: (Int32) -> LockedUseProcessFacts?, trusted: (Int32) -> Bool) -> Bool {
    guard child > 1, let before = read(child), before.parent > 1, let parentBefore = read(before.parent),
          trusted(before.parent),
          let after = read(child), after == before,
          let parentAfter = read(before.parent), parentAfter == parentBefore else { return false }
    return true
}

/// Reads `pid`'s parent and start time from the kernel, or nil if it is gone.
public func lockedUseReadProcessFacts(_ pid: Int32) -> LockedUseProcessFacts? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return LockedUseProcessFacts(parent: Int32(bitPattern: info.pbi_ppid),
        started: info.pbi_start_tvsec &* 1_000_000 &+ info.pbi_start_tvusec)
}

/// Whether the running code of `pid` satisfies `requirement`. Any failure reads as no.
public func lockedUseProcessSatisfies(_ pid: Int32, requirement: String) -> Bool {
    var code: SecCode?
    let attributes = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code else { return false }
    var parsed: SecRequirement?
    guard SecRequirementCreateWithString(requirement as CFString, [], &parsed) == errSecSuccess, let parsed else { return false }
    return SecCodeCheckValidity(code, [], parsed) == errSecSuccess
}
