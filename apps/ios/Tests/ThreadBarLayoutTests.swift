import Testing
import CoreGraphics
@testable import Ace

/// The thread's bar on a phone: the title leads and ⋯ trails, with Chat and Changes beside ⋯
/// only while the title keeps its room; otherwise they move into ⋯, never ⋯ into the system's
/// overflow.
@Suite struct ThreadBarLayoutTests {
    private let phones: [CGFloat] = [375, 393, 402, 430, 440]

    private func phone(_ width: CGFloat, pages: Int = 2, largeText: Bool = false) -> ThreadBarLayout {
        ThreadBarLayout(pageWidth: width, leadingTitle: true, panel: false, pages: pages, largeText: largeText)
    }

    @Test func atTheDefaultTextSizeEveryIPhoneKeepsChatAndChangesBesideTheMenu() {
        for width in phones {
            let bar = phone(width)
            #expect(bar.switchInBar, "\(width)pt keeps the switch")
            #expect(bar.headingWidth >= ThreadBarLayout.minimumTitle, "\(width)pt keeps a readable title")
        }
    }

    @Test func atAccessibilityTextSizesChatAndChangesMoveIntoTheMenuAndTheTitleTakesTheirRoom() {
        for width in phones {
            let large = phone(width, largeText: true)
            #expect(!large.switchInBar, "\(width)pt at large text moves the switch into ⋯")
            #expect(large.headingWidth > phone(width).headingWidth, "the title gets the switch's room")
        }
    }

    @Test func aBarTooNarrowForATitleBesideTheSwitchMovesTheSwitchIntoTheMenu() {
        let narrow = phone(320)
        #expect(!narrow.switchInBar)
        #expect(narrow.headingWidth > 0)
    }

    @Test func aThreadWithoutChangesHasNoSwitchInItsBar() {
        #expect(!phone(440, pages: 1).switchInBar)
        #expect(phone(440, pages: 1).headingWidth == phone(440, largeText: true).headingWidth)
    }

    @Test func theTitleAlwaysLeavesRoomForTheBackButtonAndTheMenu() {
        for width in stride(from: CGFloat(0), through: 1400, by: 7) {
            for largeText in [false, true] {
                for leading in [false, true] {
                    for panel in [false, true] {
                        let bar = ThreadBarLayout(pageWidth: width, leadingTitle: leading, panel: panel, pages: panel ? 0 : 2,
                                                  largeText: largeText)
                        #expect(bar.headingWidth >= 0)
                        // Two bar buttons and the bar's margins are never given to the title.
                        if bar.headingWidth > 0 {
                            #expect(bar.headingWidth + 2 * AceDesign.Size.tap + 2 * AceDesign.Space.margin <= width)
                        }
                    }
                }
            }
        }
    }

    @Test func aCentredTitleOnIPadIsCappedAndLeavesThePanelToggleItsRoom() {
        let wide = ThreadBarLayout(pageWidth: 1180, leadingTitle: false, panel: true, pages: 0, largeText: false)
        #expect(wide.headingWidth == 5 * AceDesign.Size.tap)
        let tight = ThreadBarLayout(pageWidth: 400, leadingTitle: false, panel: true, pages: 0, largeText: false)
        #expect(tight.headingWidth < 5 * AceDesign.Size.tap)
        #expect(!tight.switchInBar)
    }

    @Test func withTheSwitchInTheBarTheMenuOffersTheThreadsOtherScreens() {
        let pages = ThreadPages(ThreadPageFacts(changedFiles: 3))
        #expect(ThreadDestination.menuScreens(pages: pages, shown: .chat, switchInBar: true) == [.files, .terminal, .browser, .agents])
    }

    @Test func withTheSwitchInTheMenuItOffersThePageThatIsNotShowingFirst() {
        let pages = ThreadPages(ThreadPageFacts(changedFiles: 3))
        let onChat = ThreadDestination.menuScreens(pages: pages, shown: .chat, switchInBar: false)
        #expect(onChat == [.changes, .files, .terminal, .browser, .agents])
        let onChanges = ThreadDestination.menuScreens(pages: pages, shown: .changes, switchInBar: false)
        #expect(onChanges == [.chat, .files, .terminal, .browser, .agents])
        #expect(ThreadDestination.chat.page == .chat, "Chat from ⋯ shows the Chat page")
    }

    @Test func aThreadWithNothingToSwitchToOffersNoPageInTheMenu() {
        let chat = ThreadPages(ThreadPageFacts(chat: true))
        #expect(ThreadDestination.menuScreens(pages: chat, shown: .chat, switchInBar: false) == [.browser, .agents])
    }

    @Test func besideTheIPadPanelTheMenuOpensChangesAndTheToolsAsItsTabs() {
        #expect(ThreadDestination.menuScreens(pages: nil, shown: .chat, switchInBar: false) == [.changes, .files, .terminal, .browser])
    }
}
