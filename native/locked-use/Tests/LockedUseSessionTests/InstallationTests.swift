import XCTest
import LockedUseSystem

final class InstallationTests: XCTestCase {
    func testTheMechanismMustBeReachableFromTheScreensaverRight() {
        let database: [String: [String: Any]] = [
            "system.login.screensaver": ["rule": ["dev.ace.locked-use.remote", "use-login-window-ui"]],
            "dev.ace.locked-use.remote": ["mechanisms": ["AceLockedUseAuthorization:permit"]],
            "use-login-window-ui": ["mechanisms": ["builtin:other"]],
        ]
        XCTAssertTrue(lockedUseRuleReaches("AceLockedUseAuthorization:permit", from: "system.login.screensaver") { database[$0] })
        XCTAssertFalse(lockedUseRuleReaches("AceLockedUseAuthorization:permit", from: "system.login.screensaver") {
            $0 == "dev.ace.locked-use.remote" ? nil : database[$0]
        })
        let loop: [String: [String: Any]] = ["a": ["rule": "b"], "b": ["rule": "a"]]
        XCTAssertFalse(lockedUseRuleReaches("x", from: "a") { loop[$0] }, "Rule cycles terminate")
    }

    func testOnlyAnImmediateScreenLockCounts() {
        XCTAssertTrue(lockedUseScreenLockIsImmediate("2026-10-26 12:06:47.751 sysadminctl[1:2] screenLock delay is immediate\n"))
        XCTAssertFalse(lockedUseScreenLockIsImmediate("sysadminctl[1:2] screenLock delay is 300 seconds"))
        XCTAssertFalse(lockedUseScreenLockIsImmediate("sysadminctl[1:2] screenLock is off"))
        XCTAssertFalse(lockedUseScreenLockIsImmediate(""))
    }

    func testPeerRequirementsPinAValidTeamAndIdentifier() throws {
        XCTAssertEqual(try lockedUsePeerRequirement(identifier: "dev.ace.screen-helper", team: "ABCDE12345"),
            #"anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345" and identifier "dev.ace.screen-helper""#)
        XCTAssertThrowsError(try lockedUsePeerRequirement(identifier: "x", team: "short"))
        XCTAssertThrowsError(try lockedUsePeerRequirement(identifier: "x\" or anchor apple", team: "ABCDE12345"))
    }
}
