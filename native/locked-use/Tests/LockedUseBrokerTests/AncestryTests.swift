import XCTest
import Darwin
import LockedUseSystem

/// A substitute process table whose entries can change between reads, as a real one can.
final class ProcessTable {
    var entries: [Int32: LockedUseProcessFacts] = [:]
    /// Runs once, after the trust check and before the facts are read again.
    var duringCheck: (() -> Void)?

    func read(_ pid: Int32) -> LockedUseProcessFacts? { entries[pid] }
    func trusted(_ allowed: Set<Int32>) -> (Int32) -> Bool {
        { [self] pid in
            defer { duringCheck?(); duringCheck = nil }
            return allowed.contains(pid)
        }
    }
}

final class AncestryTests: XCTestCase {
    let daemon: Int32 = 400
    let service: Int32 = 500
    let table = ProcessTable()

    override func setUp() {
        table.entries = [daemon: .init(parent: 1, started: 10), service: .init(parent: daemon, started: 20)]
    }

    func vet(trusting allowed: Set<Int32>) -> Bool {
        lockedUseVetAncestry(child: service, read: table.read, trusted: table.trusted(allowed))
    }

    func testAServiceSpawnedByTheTrustedDaemonIsAccepted() {
        XCTAssertTrue(vet(trusting: [daemon]))
    }

    func testAServiceSpawnedByAnyOtherProcessIsRefused() {
        table.entries[666] = .init(parent: 1, started: 30)
        table.entries[service] = .init(parent: 666, started: 20)
        XCTAssertFalse(vet(trusting: [daemon]), "A same-user process ran its own copy of the signed service")
    }

    func testAnOrphanedOrVanishedServiceIsRefused() {
        table.entries[service] = .init(parent: 1, started: 20)
        XCTAssertFalse(vet(trusting: [1, daemon]), "Adopted by launchd: its daemon is gone")
        table.entries[service] = nil
        XCTAssertFalse(vet(trusting: [daemon]))
    }

    func testAParentThatExitsOrIsReplacedDuringTheCheckIsRefused() {
        // The daemon exits mid-check: launchd adopts the service.
        table.duringCheck = { [table, service] in table.entries[service] = .init(parent: 1, started: 20) }
        XCTAssertFalse(vet(trusting: [daemon]))
        // The daemon exits and its pid is recycled by another process before the recheck.
        setUp()
        table.duringCheck = { [table, daemon] in table.entries[daemon] = .init(parent: 1, started: 99) }
        XCTAssertFalse(vet(trusting: [daemon]))
    }

    func testTheKernelReportsThisProcesssRealParentAndItPassesOnlyWhenTrusted() {
        let facts = lockedUseReadProcessFacts(getpid())
        XCTAssertEqual(facts?.parent, getppid())
        XCTAssertTrue(lockedUseVetAncestry(child: getpid(), read: lockedUseReadProcessFacts, trusted: { $0 == getppid() }))
        XCTAssertFalse(lockedUseVetAncestry(child: getpid(), read: lockedUseReadProcessFacts, trusted: { $0 != getppid() }))
    }

    func testCodeWithoutAcesTeamSignatureDoesNotSatisfyTheDaemonRequirement() throws {
        // The test runner is not signed by this (made-up) team, so it can never pass.
        let requirement = try lockedUseTeamRequirement(team: "ABCDE12345")
        XCTAssertFalse(lockedUseProcessSatisfies(getppid(), requirement: requirement))
        XCTAssertFalse(lockedUseProcessSatisfies(-1, requirement: requirement))
        XCTAssertThrowsError(try lockedUseTeamRequirement(team: "abc\" or anchor apple"))
    }
}
