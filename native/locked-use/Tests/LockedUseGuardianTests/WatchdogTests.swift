import XCTest
import LockedUseGuardianKit

final class WatchdogTests: XCTestCase {
    func testSilentOwnerTripsARelockAfterTheHeartbeatTimeout() throws {
        var dog = LockedUseWatchdog()
        XCTAssertNil(try dog.arm(attempt: "a", owner: 10, now: 0))
        XCTAssertNil(dog.tick(now: 900_000_000))
        XCTAssertTrue(dog.heartbeat(attempt: "a", owner: 10, now: 900_000_000).alive)
        XCTAssertNil(dog.tick(now: 1_800_000_000))
        XCTAssertEqual(dog.tick(now: 1_900_000_000), .heartbeatLost)
        XCTAssertFalse(dog.heartbeat(attempt: "a", owner: 10, now: 1_950_000_000).alive, "A late heartbeat cannot revive it")
    }

    func testRelockRetriesAreBoundedSoAManualUnlockIsNotFought() throws {
        var dog = LockedUseWatchdog()
        _ = try dog.arm(attempt: "a", owner: 10, now: 0)
        var trips = [dog.linkDropped(owner: 10, now: 1)]
        var time: UInt64 = 1
        for _ in 0..<40 { time += 500_000_000; trips.append(dog.tick(now: time)) }
        XCTAssertEqual(trips.compactMap { $0 }, Array(repeating: .linkDropped, count: 1 + LockedUseWatchdog.retries))
    }

    func testOnlyTheArmedOwnerCanDropTheLinkHeartbeatOrDisarm() throws {
        var dog = LockedUseWatchdog()
        _ = try dog.arm(attempt: "a", owner: 10, now: 0)
        XCTAssertThrowsError(try dog.arm(attempt: "b", owner: 11, now: 1))
        XCTAssertNil(dog.linkDropped(owner: 11, now: 2))
        XCTAssertNil(dog.ownerExited(11, now: 2))
        XCTAssertFalse(dog.heartbeat(attempt: "a", owner: 11, now: 3).alive)
        XCTAssertFalse(dog.disarm(attempt: "a", owner: 11))
        XCTAssertFalse(dog.disarm(attempt: "b", owner: 10))
        XCTAssertEqual(dog.ownerExited(10, now: 4), .ownerExited)
    }

    func testDisarmAfterConfirmedLockEndsSupervision() throws {
        var dog = LockedUseWatchdog()
        _ = try dog.arm(attempt: "a", owner: 10, now: 0)
        XCTAssertTrue(dog.disarm(attempt: "a", owner: 10))
        XCTAssertNil(dog.linkDropped(owner: 10, now: 1))
        XCTAssertNil(dog.tick(now: 10_000_000_000))
    }

    func testABackwardsClockTripsInsteadOfExtendingTheDeadline() throws {
        var dog = LockedUseWatchdog()
        _ = try dog.arm(attempt: "a", owner: 10, now: 5_000_000_000)
        XCTAssertEqual(dog.tick(now: 1), .clockWentBackwards)
    }
}
