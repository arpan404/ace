import XCTest
@testable import ScreenHelper

final class EncodeTrialTests: XCTestCase {
    func testATrialWhoseEncodeNeverCompletesTimesOutWithinItsBoundAndListsNoHEVC() {
        let release = DispatchSemaphore(value: 0)
        // Lets the stalled trial's thread finish once the test is done with it.
        defer { release.signal() }
        let started = Date()
        let hevc = EncodeTrial.run(.hevc, deadline: 0.2) { codec in
            release.wait()
            return EncodeTrial.entry(codec, state: "ok", hardware: true)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        XCTAssertEqual(hevc["state"] as? String, "timed-out")
        XCTAssertFalse(EncodeTrial.works(hevc))
        let h264 = EncodeTrial.entry(.h264, state: "ok", hardware: true)
        XCTAssertEqual(EncodeTrial.codecs([h264, hevc]), ["jpeg", "h264"])
    }

    func testAWorkingHardwareHEVCTrialListsHEVCBesideH264() {
        let report = [EncodeTrial.entry(.h264, state: "ok", hardware: true), EncodeTrial.entry(.hevc, state: "ok", hardware: true)]
        XCTAssertEqual(EncodeTrial.codecs(report), ["jpeg", "h264", "hevc"])
        let software = [report[0], EncodeTrial.entry(.hevc, state: "ok", hardware: false)]
        XCTAssertEqual(EncodeTrial.codecs(software), ["jpeg", "h264"])
    }

    func testATrialThatFinishesInTimeReportsItsOwnAnswer() {
        let entry = EncodeTrial.run(.h264, deadline: 1) { EncodeTrial.entry($0, state: "failed", hardware: false) }
        XCTAssertEqual(entry["state"] as? String, "failed")
    }
}
