import Foundation
import Testing
@testable import Ace

/// The first run after pairing, from the bridge's words (`bridge/first-run.ts`, whose tests cover
/// how the daemon's checklist becomes these rows): whether pairing opens it, and where each
/// agent's row leads.
struct FirstRunTests {
    private func reply(_ json: String) throws -> FirstRunReply {
        try JSONDecoder().decode(FirstRunReply.self, from: Data(json.utf8))
    }
    private func row(_ provider: String, _ label: String, _ token: String, ready: Bool, step: String?, next: Bool = false) -> String {
        let step = step.map { "\"\($0)\"" } ?? "null"
        return #"{"provider":"\#(provider)","name":"\#(provider)","status":{"label":"\#(label)","token":"\#(token)"},"detail":null,"ready":\#(ready),"step":\#(step),"next":\#(next)}"#
    }
    private func screen(offer: Bool, ready: Int, installed: [String], missing: [String]) -> String {
        #"{"ok":true,"screen":{"offer":\#(offer),"dismissed":false,"ready":\#(ready),"installed":[\#(installed.joined(separator: ","))],"missing":[\#(missing.joined(separator: ","))],"progress":"\#(ready) of \#(installed.count) ready"}}"#
    }

    @Test func aComputerWithAReadyAgentIsNotOfferedTheFirstRun() throws {
        let page = try reply(screen(offer: false, ready: 1, installed: [row("claude", "Ready", "done", ready: true, step: nil)], missing: [])).page()
        #expect(!page.offer)
        #expect(page.installed.first?.ready == true)
        #expect(FirstRunRoute(step: page.installed.first?.step) == .page(start: nil))
    }

    @Test func aSignedOutAgentLeadsToTheSignInPage() throws {
        let page = try reply(screen(offer: true, ready: 0,
                                    installed: [row("codex", "Sign in needed", "needsYou", ready: false, step: "sign_in", next: true)],
                                    missing: [])).page()
        #expect(page.offer)
        #expect(page.installed.first?.next == true)
        #expect(FirstRunRoute(step: page.installed.first?.step) == .signIn)
    }

    @Test func aMissingAgentOpensItsPageWithTheInstallPlan() throws {
        let page = try reply(screen(offer: true, ready: 0, installed: [],
                                    missing: [row("opencode", "Not installed", "neutral", ready: false, step: "install")])).page()
        #expect(page.offer)
        #expect(FirstRunRoute(step: page.missing.first?.step) == .page(start: "install"))
        #expect(FirstRunRoute(step: "update") == .page(start: "update"))
    }

    @MainActor @Test func doneIsKeptOnlyWhenTheComputerSavesIt() async throws {
        let saved = try reply(screen(offer: false, ready: 1, installed: [row("claude", "Ready", "done", ready: true, step: nil)], missing: []))
        #expect(await FirstRunReply.dismissal { saved } == nil)
    }

    @MainActor @Test func doneThatTheComputerRefusesSaysWhyAndCanBeTriedAgain() async throws {
        let refused = try reply(#"{"ok":false,"message":"This computer doesn't share its coding agents with this phone."}"#)
        #expect(await FirstRunReply.dismissal { refused } == "This computer doesn't share its coding agents with this phone.")
    }

    @MainActor @Test func doneThatNeverReachesTheComputerIsNotTakenAsSaved() async {
        var sent = 0
        let problem = await FirstRunReply.dismissal {
            sent += 1
            throw ServiceFailure(message: "The request timed out.", transport: true)
        }
        #expect(sent == 1)
        #expect(problem == FirstRunReply.notKept)
    }

    @Test func aComputerThatWontListItsAgentsSaysWhy() throws {
        let refused = try reply(#"{"ok":false,"message":"This computer doesn't share its coding agents with this phone."}"#)
        #expect(throws: ServiceFailure.self) { try refused.page() }
    }
}
