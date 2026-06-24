import XCTest
@testable import AceDesktop

@MainActor
final class AppStoreTests: XCTestCase {
    func testSidebarNavigationMovesAcrossProjectsAndThreads() {
        let store = testStore()
        store.applySidebarSnapshot(
            projects: [
                Project(id: "project-a", title: "Alpha", workspaceRoot: "/tmp/alpha"),
                Project(id: "project-b", title: "Beta", workspaceRoot: "/tmp/beta"),
            ],
            threads: [
                SidebarThread(id: "thread-a", title: "Alpha Thread", updated: "2", projectRoot: "/tmp/alpha"),
                SidebarThread(id: "thread-b", title: "Beta Thread", updated: "1", projectRoot: "/tmp/beta"),
            ]
        )

        XCTAssertEqual(store.selectedSidebarItem, .thread("thread-a"))
        store.selectNextSidebarItem()
        XCTAssertEqual(store.selectedSidebarItem, .project("project-b"))
        store.selectNextSidebarItem()
        XCTAssertEqual(store.selectedSidebarItem, .thread("thread-b"))
        store.selectPreviousSidebarItem()
        XCTAssertEqual(store.selectedSidebarItem, .project("project-b"))
    }

    func testPinnedThreadsLeadKeyboardNavigation() {
        let store = testStore()
        store.applySidebarSnapshot(
            projects: [
                Project(id: "project-a", title: "Alpha", workspaceRoot: "/tmp/alpha"),
            ],
            threads: [
                SidebarThread(id: "thread-a", title: "Alpha Thread", updated: "1", projectRoot: "/tmp/alpha"),
                SidebarThread(id: "thread-b", title: "Pinned Thread", updated: "2", projectRoot: nil),
            ]
        )
        store.togglePinnedThread("thread-b")

        XCTAssertEqual(store.sidebarNavigationItems.first, .thread("thread-b"))
    }

    func testFocusActionsOpenSidebarAndTargetComposer() {
        let store = testStore()

        store.sidebarCollapsed = true
        store.focusSidebar()
        XCTAssertFalse(store.sidebarCollapsed)
        XCTAssertEqual(store.focusedArea, .sidebar)

        store.focusComposer()
        XCTAssertEqual(store.focusedArea, .composer)
    }

    private func testStore() -> AppStore {
        UserDefaults.standard.removeObject(forKey: "ace.sidebar.pinnedProjectIds")
        UserDefaults.standard.removeObject(forKey: "ace.sidebar.pinnedThreadIds")
        return AppStore(client: AceWebSocketClient(endpoint: URL(string: "ws://127.0.0.1:1/api/ws")!))
    }
}
