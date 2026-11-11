import Testing
@testable import Ace

struct SettingsDraftTests {
    @Test func reconnectKeepsUnsavedPromptAndItsOriginalRevision() {
        var draft = PromptDraft()
        draft.receive(text: "original", revision: "r1")
        draft.text = "my edits"
        draft.receive(text: "changed remotely", revision: "r2")
        #expect(draft.text == "my edits")
        #expect(draft.revision == "r1")
        #expect(draft.reloadAvailable)
    }

    @Test func editsTypedWhileSavingRemainUnsavedAfterTheReply() {
        var draft = PromptDraft()
        draft.receive(text: "original", revision: "r1")
        draft.text = "sent to machine"
        let submitted = draft.text
        draft.text = "typed while saving"
        draft.saved(text: submitted, revision: "r2")
        #expect(draft.text == "typed while saving")
        #expect(draft.dirty)
        #expect(draft.revision == "r2")
    }

    @Test func unchangedPromptAcceptsTheReconnectedFile() {
        var draft = PromptDraft()
        draft.receive(text: "original", revision: "r1")
        draft.receive(text: "changed remotely", revision: "r2")
        #expect(draft.text == "changed remotely")
        #expect(draft.revision == "r2")
        #expect(!draft.dirty)
    }
}

@MainActor struct SettingsSignInTests {
    @Test func leavingTheWholeFlowCancelsItsUnfinishedSignIn() async {
        var cancelled: [String] = []
        var flow: SignInLifetime? = SignInLifetime()
        flow?.cancel = { cancelled.append($0) }
        flow?.unfinishedSession = "login-1"
        // A child screen borrows the flow; releasing that borrow leaves sign-in running.
        var child = flow
        child = nil
        #expect(cancelled.isEmpty)
        flow = nil
        for _ in 0..<100 where cancelled.isEmpty { await Task.yield() }
        #expect(cancelled == ["login-1"])
        _ = child
    }

    @Test func leavingAFinishedSignInDoesNotCancelIt() async {
        var cancelled: [String] = []
        var flow: SignInLifetime? = SignInLifetime()
        flow?.cancel = { cancelled.append($0) }
        flow?.unfinishedSession = nil
        flow = nil
        await Task.yield()
        #expect(cancelled.isEmpty)
    }
}
