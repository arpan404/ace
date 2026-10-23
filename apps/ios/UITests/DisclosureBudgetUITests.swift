import XCTest

/// How fast things open in place in a finished transcript, against the fixture's `ios-log-long`
/// thread (six turns of 80 steps): a "Worked for" log the first time and again, a step's diff, a
/// thought, and a thought read in full. Run with the `AcePerf` scheme beside the other budgets
/// (README "Performance budgets"); the app's own numbers come from `--perf-probe`
/// (`Sources/Models/DisclosureTrace.swift`). Spends no provider quota.
@MainActor final class DisclosureBudgetUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testOpeningFinishedWorkInPlaceStaysWithinBudget() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841",
                               "--spike-items", "200", "--perf-probe"]
        app.launch()
        XCTAssertTrue(app.openThread("ios-log-long"))
        let toggle = app.buttons.matching(identifier: "work.toggle").allElementsBoundByIndex.last { $0.isHittable }
        let work = try XCTUnwrap(toggle, "no settled log on screen")

        // A head that stays in view reads its steps ahead, so the first open shows rows, not
        // rows standing in for them.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 1))
        let cold = try open(app, kind: "steps") { work.tap() }
        let group = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "work.group.")).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 10), "the opened log shows its steps")
        report("log first open: shown ms, patches, bytes", [cold.ms, cold.patches, cold.bytes])
        XCTAssertFalse(cold.waited, "the first open waited on its read")
        XCTAssertLessThan(cold.ms, DisclosureBudget.firstOpenMs)

        // Its group of about 60 steps opens in place, all at once.
        let opened = try open(app, kind: "group") { group.tap() }
        report("group of steps: shown ms", [opened.ms])
        XCTAssertLessThan(opened.ms, DisclosureBudget.groupMs)

        // Closed and opened again (its group still open), the steps it read show at once and nothing is sent again.
        var warm: [Double] = [], warmPatches: [Double] = [], warmBytes: [Double] = [], warmMain: [Double] = [], waited: [String] = []
        for _ in 0..<5 {
            work.tap()
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.6))
            let again = try open(app, kind: "steps") { work.tap() }
            warm.append(again.ms); warmPatches.append(again.patches); warmBytes.append(again.bytes); warmMain.append(again.mainMs)
            if again.waited { waited.append("reopen waited on a read") }
        }
        report("log reopen: shown ms", warm)
        report("log reopen: patches", warmPatches)
        report("log reopen: bytes", warmBytes)
        report("log reopen: main-thread apply ms", warmMain)
        XCTAssertEqual(waited, [], "a reopened log never shows its loading rows")
        XCTAssertLessThan(median(warm), DisclosureBudget.reopenMs)
        XCTAssertLessThanOrEqual(median(warmPatches), DisclosureBudget.reopenPatches)
        XCTAssertLessThan(median(warmBytes), DisclosureBudget.reopenBytes)

        // A step's diff and a thought open in place from rows already held.
        let edit = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "step.", "Edit")).allElementsBoundByIndex.first { $0.isHittable }
        let step = try open(app, kind: "step") { try XCTUnwrap(edit, "no edit step on screen").tap() }
        report("step detail: shown ms", [step.ms])
        let thoughtRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thought.")).allElementsBoundByIndex.first { $0.isHittable }
        let thought = try open(app, kind: "thought") { try XCTUnwrap(thoughtRow, "no thought on screen").tap() }
        report("thought: shown ms", [thought.ms])
        XCTAssertLessThan(step.ms, DisclosureBudget.inPlaceMs)
        XCTAssertLessThan(thought.ms, DisclosureBudget.inPlaceMs)

        // A thought longer than its row reads the rest into the reader.
        let full = app.buttons["Read full thought"].firstMatch
        XCTAssertTrue(full.waitForExistence(timeout: 5))
        let message = try open(app, kind: "message") { full.tap() }
        report("full thought: shown ms", [message.ms])
        XCTAssertLessThan(message.ms, DisclosureBudget.fullMessageMs)
        app.buttons["Done"].firstMatch.tap()
    }

    private struct Opened { let ms: Double; let patches: Double; let bytes: Double; let mainMs: Double; let waited: Bool }
    private func open(_ app: XCUIApplication, kind: String, tap: () throws -> Void) throws -> Opened {
        let before = app.probe["disclosures"]
        try tap()
        XCTAssertTrue(app.waitForCount("disclosures", from: before, timeout: 15), "\(kind) never opened")
        let probe = app.probe
        XCTAssertEqual(probe["disclosure.kind"], kind)
        return Opened(ms: try XCTUnwrap(app.probeValue("disclosure.shownMs")), patches: app.probeValue("disclosure.patches") ?? 0,
                      bytes: app.probeValue("disclosure.bytes") ?? 0, mainMs: app.probeValue("disclosure.mainMs") ?? 0, waited: probe["disclosure.waited"] == "true")
    }
    private func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        return sorted.isEmpty ? .infinity : sorted[sorted.count / 2]
    }
    private func report(_ name: String, _ values: [Double]) {
        let line = "\(name): " + values.map { String(format: "%.1f", $0) }.joined(separator: ", ")
        print("perf-budget \(line)")
        let attachment = XCTAttachment(string: line)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

/// Budgets for opening in place, about 1.5 to 5 times the measured median (Perf, iOS 26 simulator,
/// loopback fixture, 2026-10-23; before the fix in brackets). Lower them when opening gets faster;
/// never raise one without a measured reason.
enum DisclosureBudget {
    static let firstOpenMs = 150.0     // [48; 71 after placeholder rows and a 147 KB read]
    static let groupMs = 120.0         // [28; 95 when all 60 rows laid out in one frame]
    static let reopenMs = 120.0        // [26; 18 to 64, then every page arrived again]
    static let reopenPatches = 2.0     // [1, the header; 5 to 6, every page again]
    static let reopenBytes = 16_000.0  // [3,933]
    static let inPlaceMs = 120.0       // [step 24, thought 21]
    static let fullMessageMs = 600.0   // [273, mostly the sheet; 314 behind a spinner]
}
