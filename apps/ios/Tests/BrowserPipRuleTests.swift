import Foundation
import Testing
@testable import Ace

/// When the live page floats in picture-in-picture, as web's `pip-rules.ts` decides it.
@Suite struct BrowserPipRuleTests {
    private func state(closed: Bool = false, status: String = "ready", url: String = "https://shop.test/",
                       agent: String? = "Claude", audible: Bool? = nil, blank: Bool? = false) -> BrowserViewInfo.State {
        BrowserViewInfo.State(
            url: url, closed: closed, status: status, reason: nil, loading: false, loadError: nil, activeTabId: "tab-1",
            tabs: [BrowserViewInfo.Tab(id: "tab-1", title: "Shop", url: url, agent: agent)], moreTabs: 0, blank: blank,
            shown: BrowserViewInfo.Shown(canGoBack: false, canGoForward: false, zoom: nil, agent: agent, private: false,
                                         pointer: nil, audible: audible))
    }
    private func shows(_ state: BrowserViewInfo.State?, showing: Bool = false, dismissed: Bool = false, enabled: Bool = true) -> Bool {
        BrowserPipRule.shows(state: state, showingBrowser: showing, dismissed: dismissed, enabled: enabled)
    }

    @Test func leavingTheBrowserWhileAnAgentBrowsesFloatsThePage() {
        #expect(shows(state()))
        #expect(!shows(state(), showing: true))
    }

    @Test func aPagePlayingSoundFloatsWithNoAgentBrowsing() {
        #expect(shows(state(agent: nil, audible: true)))
        #expect(!shows(state(agent: nil)))
    }

    @Test func theSettingOffMeansNoPictureInPicture() {
        #expect(!shows(state(), enabled: false))
    }

    @Test func dismissedStaysDismissed() {
        #expect(!shows(state(), dismissed: true))
    }

    @Test func aClosedPausedRecoveringOrBlankBrowserDoesntFloat() {
        #expect(!shows(nil))
        #expect(!shows(state(closed: true)))
        #expect(!shows(state(status: "paused")))
        #expect(!shows(state(status: "recovering")))
        #expect(!shows(state(url: "about:blank")))
        #expect(!shows(state(url: "")))
        #expect(!shows(state(blank: true)))
    }
}
