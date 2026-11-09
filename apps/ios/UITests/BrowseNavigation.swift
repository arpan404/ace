import XCTest

extension XCUIApplication {
    /// The agent tree, from the thread's ⋯ menu.
    @MainActor func openAgents() {
        XCTAssertTrue(buttons["thread.menu"].waitForExistence(timeout: 10))
        buttons["thread.menu"].tap()
        XCTAssertTrue(threadMenuItem("thread.agents").waitForExistence(timeout: 10))
        threadMenuItem("thread.agents").tap()
    }
    /// The thread's title, which opens its menu: model, effort and access, then the thread's actions.
    @MainActor @discardableResult func threadTitle(timeout: TimeInterval = 15) -> XCUIElement {
        let title = buttons["thread.title"]
        XCTAssertTrue(title.waitForExistence(timeout: timeout), "the thread's title never showed")
        return title
    }
    /// An item of the title's menu, by identifier or (iOS 27 drops a menu item's identifier) by
    /// the start of its label.
    @MainActor func titleMenuItem(_ identifier: String, label: String) -> XCUIElement {
        buttons.matching(NSPredicate(format: "identifier == %@ OR label BEGINSWITH %@", identifier, label)).firstMatch
    }
    /// The thread's Work sheet, from the title's menu, under the checkout's header.
    @MainActor func openWork() {
        threadTitle().tap()
        let work = titleMenuItem("thread.title.work", label: "Work")
        XCTAssertTrue(work.waitForExistence(timeout: 10))
        work.tap()
    }
    /// The model picker, from the title's menu.
    @MainActor func openModelPicker(timeout: TimeInterval = 15) {
        threadTitle(timeout: timeout).tap()
        let item = titleMenuItem("thread.title.model", label: "Model")
        XCTAssertTrue(item.waitForExistence(timeout: 10), "the title's menu has no Model")
        item.tap()
    }
    /// An item of the thread's ⋯ panel. iOS 27 drops a menu item's identifier and keeps its label,
    /// so the item is found by either. Secondary actions are grouped in native menus.
    @MainActor func threadMenuItem(_ identifier: String) -> XCUIElement {
        let labels = ["thread.changes": "Changes", "thread.agents": "Agent tree", "thread.search": "Find in thread",
                      "thread.files": "Files", "thread.browser": "Browser", "thread.devices": "Devices",
                      "thread.terminal": "Terminal", "thread.tools": "Skills and tools",
                      "thread.reload": "Reload from machine", "thread.scripts": "Run and preview",
                      "thread.work": "Work", "thread.attachments": "Attachments",
                      "thread.computer": "Computer use", "thread.openIn": "Open in",
                      "thread.turns": "Turns", "thread.logs": "Logs",
                      "thread.menu.rename": "Rename", "thread.forkLast": "Fork from the last turn",
                      "thread.merge": "Bring back to parent", "thread.continueOn": "Continue on"]
        // A menu item with a second line reads both in its label: match its first words.
        let item = buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@ OR label BEGINSWITH %@", identifier,
                                                labels[identifier] ?? identifier, "\(labels[identifier] ?? identifier),")).firstMatch
        if item.waitForExistence(timeout: 2) && item.isHittable { return item }
        // On a phone Changes is a page beside Chat in the bar, not a ⋯ entry: close the panel
        // and hand back the bar's button.
        let page = buttons["thread.page.changes"]
        if identifier == "thread.changes", page.exists {
            if buttons["thread.options.tools"].exists { coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap() }
            _ = page.waitForExistence(timeout: 3)
            return page
        }
        let conversation: Set<String> = ["thread.search", "thread.turns", "thread.attachments", "thread.menu.rename", "thread.forkLast", "thread.merge"]
        let group = identifier == "thread.continueOn" || identifier.hasPrefix("thread.action.") ? "organize"
            : conversation.contains(identifier) ? "conversation" : "tools"
        let category = buttons["thread.options.\(group)"]
        if category.waitForExistence(timeout: 2) { category.tap() }
        _ = item.waitForExistence(timeout: 3)
        let menu = collectionViews.firstMatch
        for _ in 0..<4 where menu.exists && !(item.exists && item.isHittable) { menu.swipeUp() }
        return item
    }
    /// The Search tab, before a query: its places and the latest threads.
    @MainActor func openSearch() {
        let search = buttons.matching(NSPredicate(format: "identifier == 'tab.search' OR label == 'Search'")).firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 30))
        search.tap()
        XCTAssertTrue(buttons["search.place.settings"].waitForExistence(timeout: 10))
    }
    /// Pull requests and Issues, from Search's places.
    @MainActor func openPulls() {
        openSearch()
        buttons["search.place.pulls"].tap()
    }
    /// The Threads list is up: its Inbox, Snoozed and Settled control shows.
    var inboxReady: XCUIElement { buttons["threads.tab.inbox"] }
    /// The system back button of a pushed page. Some runtimes (iOS 27, the folded Duo) show it
    /// without a NavigationBar around it, so it is found by its usual identifier or label too.
    @MainActor func tapBack() {
        let inBar = navigationBars.buttons.firstMatch
        if inBar.waitForExistence(timeout: 2) { inBar.tap(); return }
        let back = buttons.matching(NSPredicate(format: "identifier == 'BackButton' OR label == 'Back'")).firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 5), "no back button showed")
        back.tap()
    }
    /// The list's compose button: the round header button (the tab bar's prominent one on iOS 27).
    var newThreadButton: XCUIElement { buttons["inbox.compose"].firstMatch }
    /// Waits for an inbox row and scrolls until it shows: the fixture lists more threads than fit.
    @MainActor @discardableResult func revealRow(_ identifier: String, timeout: TimeInterval = 30) -> XCUIElement {
        XCTAssertTrue(inboxReady.waitForExistence(timeout: timeout))
        let row = buttons[identifier]
        bringToMiddle(row)
        XCTAssertTrue(row.isHittable, "\(identifier) never showed in the inbox")
        return row
    }
    /// Taps one of Inbox, Snoozed and Settled. They are the Threads list's first row, so a list
    /// scrolled down has them out of view: it is dragged back to its top first, as a person would.
    @MainActor func tapThreadsTab(_ tab: XCUIElement) {
        for _ in 0..<12 where !(tab.exists && tab.isHittable) {
            let upper = coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
            upper.press(forDuration: 0.05, thenDragTo: coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
        }
        tab.tap()
    }
    /// Drags the list without letting it coast until `element` sits clear of the floating header
    /// and the tab bar. A swipe coasts on, and a tap made before it stops lands on whichever row
    /// slid under the finger.
    /// The drag runs down the element's own column: beside an iPad's open thread the list is not
    /// in the middle of the window.
    @MainActor func bringToMiddle(_ element: XCUIElement, attempts: Int = 30) {
        for attempt in 0..<attempts {
            // A row the lazy list hasn't loaded has no frame to read yet; its list is the one
            // under the Threads list's own Inbox control.
            let exists = element.exists
            let frame = exists ? element.frame : .zero
            let column = exists ? frame : inboxReady.exists ? inboxReady.frame : self.frame
            let x = self.frame.width > 0 ? min(max(column.midX / self.frame.width, 0.05), 0.95) : 0.5
            let lower = coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.72))
            let upper = coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.38))
            let visible = exists && frame.minY > self.frame.height * 0.2 && frame.maxY < self.frame.height * 0.82
            if visible && element.isHittable { return }
            // Above: drag down. Below: drag up. Not loaded yet: look further down the list first,
            // then back up it, since the row may have scrolled off either way.
            let above = exists ? frame.maxY <= self.frame.height * 0.2 : attempt >= attempts / 2
            if above {
                upper.press(forDuration: 0.1, thenDragTo: lower, withVelocity: .slow, thenHoldForDuration: 0.2)
            } else {
                lower.press(forDuration: 0.1, thenDragTo: upper, withVelocity: .slow, thenHoldForDuration: 0.2)
            }
        }
    }
    /// Drags the inbox list one screen further down, in the list's own column: beside an iPad's
    /// open thread the middle of the window is the thread, not the list.
    @MainActor func dragListUp() {
        let column = inboxReady.exists ? inboxReady.frame : frame
        let x = frame.width > 0 ? min(max(column.midX / frame.width, 0.05), 0.95) : 0.5
        coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.75))
            .press(forDuration: 0.05, thenDragTo: coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.3)), withVelocity: .fast, thenHoldForDuration: 0)
    }
    /// Opens Settings from Search's places, scrolled so the machine tools show.
    @MainActor func openSettings() {
        openSearch()
        buttons["search.place.settings"].tap()
        XCTAssertTrue(buttons["settings.machines"].waitForExistence(timeout: 10))
        for _ in 0..<4 where !buttons["library.projects"].isHittable { swipeUp() }
    }
    /// A row of Settings (a machine tool, `library.*`, or a page, `settings.*`), opened from
    /// Search's Settings place when it isn't showing yet. `inbox.settings` only opens Settings;
    /// `inbox.machines` opens Settings › Machines.
    @MainActor func openBrowseDestination(_ identifier: String) {
        let target = identifier == "inbox.machines" ? "settings.machines" : identifier
        if !buttons[target].exists || target == "inbox.settings" {
            openSearch()
            buttons["search.place.settings"].tap()
            XCTAssertTrue(buttons["settings.machines"].waitForExistence(timeout: 10))
        }
        guard target != "inbox.settings" else { return }
        for _ in 0..<6 where !buttons[target].isHittable { swipeUp() }
        XCTAssertTrue(buttons[target].waitForExistence(timeout: 10))
        buttons[target].tap()
    }
    /// The Changes sheet's row for `path`. The first file opens on its own, and a long diff pushes
    /// the rows after it out of the list, so that file is closed first.
    @MainActor func changesFile(_ path: String) -> XCUIElement {
        let first = buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'changes.file.'")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        if first.identifier != "changes.file.\(path)" && first.value as? String == "Open" { first.tap() }
        return buttons["changes.file.\(path)"]
    }
    /// Closes whichever redesigned sheet is on top with its X.
    @MainActor func closeSheet() {
        for id in ["modelSheet.close", "changes.close", "agents.close", "newThread.close", "settings.close"] where buttons[id].exists {
            buttons[id].tap()
            return
        }
        XCTFail("No sheet to close")
    }
}
