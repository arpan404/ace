import XCTest
import LockedUseSystem

final class InstallationTests: XCTestCase {
    let mechanism = "AceLockedUseAuthorization:permit"
    let permit: [String: Any] = ["class": "evaluate-mechanisms", "mechanisms": ["AceLockedUseAuthorization:permit"], "shared": false]
    let loginUI: [String: Any] = ["class": "evaluate-mechanisms", "mechanisms": ["builtin:other"]]

    func reaches(_ database: [String: [String: Any]]) -> Bool {
        lockedUseRuleReaches(mechanism, from: "system.login.screensaver") { database[$0] }
    }

    func testTheInstalledNamedSubRightReachesTheMechanism() {
        XCTAssertTrue(reaches([
            "system.login.screensaver": ["class": "rule", "k-of-n": 1, "rule": ["use-login-window-ui", "dev.ace.locked-use.permit"]],
            "dev.ace.locked-use.permit": permit,
            "use-login-window-ui": loginUI,
        ]))
        XCTAssertFalse(reaches([
            "system.login.screensaver": ["class": "rule", "k-of-n": 1, "rule": ["use-login-window-ui", "dev.ace.locked-use.permit"]],
            "use-login-window-ui": loginUI,
        ]), "A named sub-right that is not defined reaches nothing")
    }

    func testAMechanismsKeyOnARuleClassScreensaverRightIsIgnored() {
        // authd evaluates only `rule` for a rule-class right, so this would never run the plug-in.
        XCTAssertFalse(reaches([
            "system.login.screensaver": ["class": "rule", "k-of-n": 1, "rule": ["use-login-window-ui"],
                                         "mechanisms": ["AceLockedUseAuthorization:permit"]],
            "use-login-window-ui": loginUI,
        ]))
        XCTAssertFalse(reaches([
            "system.login.screensaver": ["class": "rule", "k-of-n": 1, "rule": ["dev.ace.locked-use.permit"]],
            "dev.ace.locked-use.permit": ["class": "rule", "mechanisms": ["AceLockedUseAuthorization:permit"]],
        ]), "Nor on a rule-class sub-right")
        XCTAssertFalse(reaches(["system.login.screensaver": ["mechanisms": ["AceLockedUseAuthorization:permit"]]]),
            "A right without a class never reaches")
    }

    func testOurBranchCountsOnlyWhenItAloneSatisfiesTheRule() {
        func screensaver(_ extra: [String: Any]) -> [String: [String: Any]] {
            ["system.login.screensaver": ["class": "rule", "rule": ["use-login-window-ui", "dev.ace.locked-use.permit"]]
                .merging(extra) { $1 },
             "dev.ace.locked-use.permit": permit, "use-login-window-ui": loginUI]
        }
        XCTAssertFalse(reaches(screensaver([:])), "Without k-of-n every name must succeed")
        XCTAssertFalse(reaches(screensaver(["k-of-n": 2])))
        XCTAssertFalse(reaches(screensaver(["k-of-n": true])))
        XCTAssertTrue(reaches(screensaver(["k-of-n": 1])))
        XCTAssertTrue(reaches([
            "system.login.screensaver": ["class": "rule", "rule": "dev.ace.locked-use.permit"],
            "dev.ace.locked-use.permit": permit,
        ]), "A sole name satisfies the rule alone")
    }

    func testRuleCyclesTerminate() {
        let loop: [String: [String: Any]] = ["a": ["class": "rule", "rule": "b"], "b": ["class": "rule", "rule": "a"]]
        XCTAssertFalse(lockedUseRuleReaches("x", from: "a") { loop[$0] })
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
