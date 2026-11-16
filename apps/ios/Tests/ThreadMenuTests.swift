import Testing
@testable import Ace

/// The thread's bar: the system's title with the project and model under it, and ⋯ as a system
/// menu that leads with the page not showing (a phone) and then the thread's screens.
@Suite struct ThreadMenuTests {
    private func title(project: String = "", place: String = "", model: ThreadTitleMenu.ModelLine? = nil) -> ThreadTitleMenu {
        ThreadTitleMenu(title: "Retry payouts", place: place, project: project, model: model)
    }
    private let opus = ThreadTitleMenu.ModelLine(provider: "claude", name: "Opus 5.5", tune: "Med", note: nil, queued: false)

    @Test func theLineUnderTheTitleNamesTheProjectThenTheModelAndItsEffort() {
        let line = title(project: "billing-reconciliation-service", place: "billing-reconciliation-service · fix/payout-retries", model: opus)
        #expect(line.subtitle == "billing-reconciliation-service · Opus 5.5 · Med")
    }

    @Test func aChatsLineIsTheModelAlone() {
        #expect(title(model: opus).subtitle == "Opus 5.5 · Med")
        let plain = ThreadTitleMenu.ModelLine(provider: "codex", name: "GPT-6.1", tune: nil, note: nil, queued: false)
        #expect(title(model: plain).subtitle == "GPT-6.1")
    }

    @Test func withoutAModelToChangeTheLineSaysWhereTheThreadIs() {
        #expect(title(project: "ace-next", place: "ace-next · main").subtitle == "ace-next · main")
        #expect(title().subtitle == "")
    }

    @Test func onAPhoneMenuOffersThePageThatIsNotShowing() {
        let pages = ThreadPages(ThreadPageFacts(changedFiles: 3))
        #expect(ThreadDestination.menuPage(pages: pages, shown: .chat) == .changes)
        #expect(ThreadDestination.menuPage(pages: pages, shown: .changes) == .chat)
        #expect(ThreadDestination.chat.page == .chat, "Chat from ⋯ shows the Chat page")
    }

    @Test func aThreadWithNothingToSwitchToOffersNoPage() {
        #expect(ThreadDestination.menuPage(pages: ThreadPages(ThreadPageFacts()), shown: .chat) == nil)
        #expect(ThreadDestination.menuPage(pages: ThreadPages(ThreadPageFacts(chat: true)), shown: .chat) == nil)
        #expect(ThreadDestination.menuPage(pages: nil, shown: .chat) == nil, "beside the iPad's panel Changes is a tab")
    }

    @Test func onAPhoneTheScreensArePushedAndAChatHasNoCheckoutScreens() {
        let pages = ThreadPages(ThreadPageFacts(changedFiles: 3))
        #expect(ThreadDestination.menuScreens(pages: pages) == [.files, .terminal, .browser, .agents])
        #expect(ThreadDestination.menuScreens(pages: ThreadPages(ThreadPageFacts(chat: true))) == [.browser, .agents])
    }

    @Test func besideTheIPadPanelTheMenuOpensChangesAndTheToolsAsItsTabs() {
        #expect(ThreadDestination.menuScreens(pages: nil) == [.changes, .files, .terminal, .browser])
    }
}
