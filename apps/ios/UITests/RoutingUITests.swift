import XCTest

/// Opening the right thread from two machines that share thread ids. Run two separate-host
/// fixtures with the routing rows first:
/// `ACE_IOS_SPIKE_PORT=9852 ACE_IOS_SPIKE_MACHINE=1 ACE_IOS_SPIKE_ROUTING=1 bun run spike:daemon`,
/// and the same on 9863
/// (`TEST_RUNNER_ACE_IOS_SPIKE_MACHINES` picks other ports). Each fixture titles its twin thread,
/// which has the same id on both machines, and words its answer after its own machine.
@MainActor final class RoutingUITests: XCTestCase, @unchecked Sendable {
    private var ports: [String] { (ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_MACHINES"] ?? "9852,9863").split(separator: ",").map(String.init) }
    private func host(_ port: String) -> String { "ios-spike-host-\(port)" }
    override func setUp() { continueAfterFailure = false }

    func testTheSameThreadIdOnTwoMachinesOpensTheTappedMachinesThread() {
        let app = launch()
        defer { app.terminate() }
        for (port, other) in [(ports[0], ports[1]), (ports[1], ports[0])] {
            app.revealRow("thread.\(host(port)).ios-routing-twin").tap()
            expectOpen(app, title: "Twin on studio-\(port)", says: "Answer from studio-\(port).", never: "Answer from studio-\(other).")
            app.tapBack()
        }
    }

    func testAChatOpensOnChatsAndAThreadWithItsTitleOnThreads() {
        let app = launch()
        defer { app.terminate() }
        let machine = host(ports[0])
        let thread = app.revealRow("thread.\(machine).ios-routing-thread")
        XCTAssertFalse(app.buttons["thread.\(machine).ios-routing-chat"].exists, "a chat is never listed in Threads")
        thread.tap()
        expectOpen(app, title: "Plan the launch", says: "Project plan, as a thread.", never: "Launch ideas, as a chat.")
        app.tapBack()

        app.tabBars.firstMatch.buttons["Chats"].tap()
        let chat = app.buttons["chat.\(machine).ios-routing-chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["chat.\(machine).ios-routing-thread"].exists, "a project thread is never listed in Chats")
        chat.tap()
        expectOpen(app, title: "Plan the launch", says: "Launch ideas, as a chat.", never: "Project plan, as a thread.")
    }

    func testOpeningAnotherMachinesTwinOverTheOpenOneShowsOnlyItsTranscript() {
        let app = launch()
        defer { app.terminate() }
        app.revealRow("thread.\(host(ports[0])).ios-routing-twin").tap()
        expectOpen(app, title: "Twin on studio-\(ports[0])", says: "Answer from studio-\(ports[0]).", never: "Answer from studio-\(ports[1]).")
        // A link to the other machine's thread with the same id, as a notification or widget opens it.
        app.open(URL(string: "ace://thread/ios-routing-twin?machine=\(host(ports[1]))")!)
        expectOpen(app, title: "Twin on studio-\(ports[1])", says: "Answer from studio-\(ports[1]).", never: "Answer from studio-\(ports[0]).")
    }

    func testThreadsPickedOnTwoMachinesMoveEachToAProjectOnItsOwnMachine() {
        let app = launch()
        defer { app.terminate() }
        let first = app.revealRow("thread.\(host(ports[0])).ios-routing-twin")
        first.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["thread.action.select"].waitForExistence(timeout: 10))
        app.buttons["thread.action.select"].tap()
        app.revealRow("thread.\(host(ports[1])).ios-routing-twin").tap()
        XCTAssertTrue(app.staticTexts["2 selected"].waitForExistence(timeout: 5))
        let move = app.buttons["select.move"]
        XCTAssertTrue(move.isEnabled, "a selection across machines can move")
        move.tap()
        // One row per machine; Move waits until a machine has a project.
        let confirm = app.buttons["move.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        XCTAssertFalse(confirm.isEnabled)
        for port in ports {
            app.buttons["move.machine.\(host(port))"].tap()
            let project = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'move.project.'")).firstMatch
            XCTAssertTrue(project.waitForExistence(timeout: 20), "studio-\(port) lists its projects")
            project.tap()
            XCTAssertTrue(app.buttons["move.machine.\(host(port))"].waitForExistence(timeout: 5), "picking goes back to the machines")
        }
        XCTAssertTrue(confirm.isEnabled)
        confirm.tap()
        let toast = app.staticTexts["inbox.toast"]
        XCTAssertTrue(toast.waitForExistence(timeout: 15))
        XCTAssertTrue(toast.label.hasPrefix("Moved 2 threads"), toast.label)
        XCTAssertTrue(app.buttons["inbox.undoMove"].exists, "one Undo for both machines")
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-machines", ports.joined(separator: ",")]
        app.launch()
        return app
    }

    /// The open page is one thread throughout: its title and its transcript.
    private func expectOpen(_ app: XCUIApplication, title: String, says: String, never: String,
                            file: StaticString = #filePath, line: UInt = #line) {
        let heading = app.buttons["thread.title"]
        let titled = NSPredicate(format: "label BEGINSWITH %@", title)
        wait(for: [expectation(for: titled, evaluatedWith: heading)], timeout: 30)
        let text = { (words: String) in app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", words)).firstMatch }
        XCTAssertTrue(text(says).waitForExistence(timeout: 20), "\(title) shows its own answer", file: file, line: line)
        XCTAssertFalse(text(never).exists, "\(title) shows no other thread's answer", file: file, line: line)
    }
}
