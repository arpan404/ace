import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct NotificationTests {
    @Test func phonePreferencesSavedBeforeUsageLimitsAndRunsKeepTheirChoicesAndAlertForBoth() throws {
        let older = #"{"inApp":{"needsYou":false,"failures":true,"finished":true,"agentSays":true},"system":{"needsYou":true,"failures":false,"finished":true,"agentSays":false}}"#
        let prefs = try JSONDecoder().decode(PhoneNotificationPrefs.self, from: Data(older.utf8))
        // What the person chose stays; the new category starts on, as on the web.
        #expect(prefs.inApp.needsYou == false)
        #expect(prefs.inApp.agentSays)
        #expect(prefs.system.failures == false)
        #expect(prefs.inApp.limits)
        #expect(prefs.system["limits"])
        #expect(prefs.inApp.automations)
        #expect(prefs.system["automations"])
    }

    @Test func aSummaryOfManyFinishedRunsPostsUnderItsOwnKeyAndOpensAce() throws {
        let frame = #"{"type":"notifications.run","key":"summary:away56","title":"57 more automation runs finished","body":"6 failed","threadId":null,"automationId":null,"delivery":{"post":true,"interrupt":true,"banner":false}}"#
        guard case .run(let alert) = try JSONDecoder().decode(NotificationPatch.self, from: Data(frame.utf8)) else {
            Issue.record("not a run patch"); return
        }
        let content = AlertContent.run(alert, hostId: "studio")
        #expect(content.identifier == "run:studio:summary:away56")
        #expect(content.title == "57 more automation runs finished")
        #expect(content.threadId == "")
    }

    @Test func runAndLimitNotificationsPostedBeforeARelaunchStillGoWhenTheirMachineIsTurnedOff() async throws {
        // Notification Center keeps what was posted; the app's memory doesn't survive the relaunch.
        let center = FakeCenter()
        let store = try defaults()
        func coordinator() -> NotificationCoordinator {
            NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: store, now: { 0 },
                                    sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        }
        func patch(_ frame: String) throws -> NotificationPatch { try JSONDecoder().decode(NotificationPatch.self, from: Data(frame.utf8)) }
        let before = coordinator()
        await before.setEnabled(true)
        before.receive(try patch(#"{"type":"notifications.run","key":"r1","title":"t","body":"b","automationId":"a","threadId":null}"#), from: "studio")
        before.receive(try patch(#"{"type":"notifications.limit","key":"reached:work:1","title":"t","body":"b"}"#), from: "studio")
        before.receive(try patch(#"{"type":"notifications.run","key":"r2","title":"t","body":"b","automationId":"a","threadId":null}"#), from: "laptop")
        for _ in 0..<20 { await Task.yield() }
        #expect(center.delivered.count == 3)
        let after = coordinator()
        after.turnedOff("studio")
        for _ in 0..<20 { await Task.yield() }
        #expect(Set(center.delivered.keys) == ["run:laptop:r2"])
    }

    @Test func aFinishedRunOpensItsThreadOnItsMachineAndGoesWhenTheMachineIsTurnedOff() async throws {
        let center = FakeCenter()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        await coordinator.setEnabled(true)
        func run(_ key: String, thread: String?, post: Bool) throws -> NotificationPatch {
            let threadField = thread.map { #","threadId":"\#($0)""# } ?? #","threadId":null"#
            let frame = #"{"type":"notifications.run","key":"\#(key)","title":"Nightly audit failed","body":"The automation run failed","automationId":"nightly"\#(threadField),"delivery":{"post":\#(post),"interrupt":false,"banner":false}}"#
            return try JSONDecoder().decode(NotificationPatch.self, from: Data(frame.utf8))
        }
        coordinator.receive(try run("r1", thread: "t-9", post: true), from: "studio")
        coordinator.receive(try run("r2", thread: nil, post: true), from: "laptop")
        // The category off for this phone: nothing reaches Notification Center.
        coordinator.receive(try run("r3", thread: "t-3", post: false), from: "studio")
        for _ in 0..<20 { await Task.yield() }
        #expect(Set(center.delivered.keys) == ["run:studio:r1", "run:laptop:r2"])
        let opened = try #require(center.delivered["run:studio:r1"])
        #expect(opened.threadId == "t-9")
        #expect(opened.hostId == "studio")
        #expect(opened.title == "Nightly audit failed")
        // Banners off or quiet hours: filed in the list without a banner or sound.
        #expect(opened.banner == false)
        #expect(opened.level == .passive)
        // A run that started no thread opens ace.
        #expect(center.delivered["run:laptop:r2"]?.threadId == "")
        coordinator.turnedOff("studio")
        for _ in 0..<20 { await Task.yield() }
        #expect(Set(center.delivered.keys) == ["run:laptop:r2"])
    }

    @Test func usageLimitChangesPostPerMachineUnlessTheyShouldNotAndGoWhenTheirMachineIsTurnedOff() async throws {
        let center = FakeCenter()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        await coordinator.setEnabled(true)
        func limit(_ key: String, post: Bool) throws -> NotificationPatch {
            let frame = #"{"type":"notifications.limit","key":"\#(key)","title":"t","body":"b","delivery":{"post":\#(post),"interrupt":true,"banner":true}}"#
            return try JSONDecoder().decode(NotificationPatch.self, from: Data(frame.utf8))
        }
        coordinator.receive(try limit("reached:work:1", post: true), from: "studio")
        coordinator.receive(try limit("reached:work:1", post: true), from: "laptop")
        // Off for this phone (the category or quiet hours): nothing reaches Notification Center.
        coordinator.receive(try limit("near:work:2", post: false), from: "studio")
        for _ in 0..<20 { await Task.yield() }
        #expect(Set(center.delivered.keys) == ["limit:studio:reached:work:1", "limit:laptop:reached:work:1"])
        coordinator.turnedOff("studio")
        for _ in 0..<20 { await Task.yield() }
        #expect(Set(center.delivered.keys) == ["limit:laptop:reached:work:1"])
    }

    @Test func aUsageLimitNotificationNamesItsMachineAndChangeAndShowsAsThePhoneDecided() throws {
        let frame = #"{"type":"notifications.limit","key":"reached:claude-work:123","title":"Claude Code · work reached its usage limit","body":"Resets 17:00 · in 2h.","delivery":{"post":true,"interrupt":false,"banner":false}}"#
        guard case .limit(let alert) = try JSONDecoder().decode(NotificationPatch.self, from: Data(frame.utf8)) else {
            Issue.record("not a limit patch"); return
        }
        let content = AlertContent.limit(alert, hostId: "mac")
        #expect(content.identifier == "limit:mac:reached:claude-work:123")
        #expect(content.title == "Claude Code · work reached its usage limit")
        // Quiet hours or banners off: filed in the list without a banner or sound.
        #expect(content.banner == false)
        #expect(content.level == .passive)
    }

    @Test func anAlertSeenLiveAndAgainInCatchUpIsPostedOnceUnderItsStableId() async throws {
        let center = FakeCenter()
        let store = LedgerStore(scope: "host", defaults: try defaults())
        let notifier = LocalNotifier(center: center)
        notifier.bind(store)
        await notifier.receive(alert("n:1"))
        await notifier.catchUp(cursor: 3, entries: [alert("n:1"), alert("n:2")], retracted: [])
        // Both reach the phone once; the same thread's second replaces its first.
        #expect(center.posted.count == 2)
        #expect(center.delivered.count == 1)
        #expect(notifier.ledger.cursor == 3)
        // After a relaunch the same catch-up page alerts nothing new.
        let relaunched = LocalNotifier(center: center)
        relaunched.bind(store)
        await relaunched.catchUp(cursor: 3, entries: [alert("n:1"), alert("n:2")], retracted: [])
        #expect(center.posted.count == 2)
    }

    @Test func catchUpWithdrawsAnAlertTheThreadNoLongerSupports() async throws {
        let center = FakeCenter()
        let notifier = LocalNotifier(center: center)
        notifier.bind(LedgerStore(scope: "host", defaults: try defaults()))
        await notifier.receive(alert("n:1", status: "done"))
        await notifier.catchUp(cursor: 1, entries: [], retracted: ["n:1"])
        #expect(center.delivered.isEmpty)
    }

    @Test func thePhonesDeliveryChoiceDecidesWhetherAndHowAnAlertIsPosted() async throws {
        let center = FakeCenter()
        let notifier = LocalNotifier(center: center)
        notifier.bind(LedgerStore(scope: "host", defaults: try defaults()))
        var off = alert("n:1", status: "failed")
        off.delivery = .init(post: false, interrupt: false, banner: false)
        var quiet = alert("n:2", status: "needs_you")
        quiet.delivery = .init(post: true, interrupt: false, banner: false)
        await notifier.receive(off)
        await notifier.catchUp(cursor: 2, entries: [off, quiet], retracted: [])
        #expect(center.posted.count == 1)
        #expect(center.posted.first?.level == .passive)
        #expect(center.posted.first?.banner == false)
        // An alert from a runtime that says nothing about delivery shows as before.
        #expect(AlertContent(alert("n:3", status: "needs_you")).level == .timeSensitive)
        #expect(AlertContent(alert("n:3")).banner)
    }

    @Test func onlyTheDaemonsFixedApproveDenyPairGetsButtonsAndUnknownStatusesNeverSayDone() {
        let approval = AlertContent(alert("n:1", status: "needs_you", actions: true))
        #expect(approval.category == AlertContent.approvalCategory)
        #expect((approval.approveOption, approval.denyOption) == ("allow", "deny"))
        #expect(approval.level == .timeSensitive)
        #expect(AlertContent(alert("n:2", status: "needs_you")).category == AlertContent.threadCategory)
        #expect(AlertContent(alert("n:3", status: "something_new")).body == "New activity")
    }

    @Test func allowAnswersTheOfferedOptionThroughTheBridgeAndClearsTheAlertOnceConfirmed() async throws {
        let (coordinator, center, session) = try await connected()
        let response = Task {
            await coordinator.respond(action: NotificationActionID.approve, notificationId: "n:7", info: approvalInfo)
        }
        let resolve = try await session.waitFor("notifications.resolve")
        #expect(resolve["optionId"] as? String == "allow")
        #expect(resolve["interactionId"] as? String == "push")
        #expect(resolve["threadId"] as? String == "thread")
        session.patch(#"{"type":"notifications.action","id":"tap-1","outcome":"confirmed"}"#)
        await response.value
        #expect(center.withdrawn == ["n:7"])
        #expect(center.posted.isEmpty)
    }

    @Test func anActionThatCannotReachTheMachineSendsNothingAndAsksToOpenAce() async throws {
        let center = FakeCenter()
        let sessions = Sessions()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(model, target: try target())
        await model.connect(target: try target(), directory: URL(fileURLWithPath: "/unused"))
        await coordinator.respond(action: NotificationActionID.deny, notificationId: "n:7", info: approvalInfo)
        #expect(sessions.values.first?.actions("notifications.resolve").isEmpty == true)
        #expect(center.posted.map(\.body) == ["Couldn't reach your machine. Open ace to answer."])
        #expect(center.posted.first?.category == AlertContent.threadCategory)
        await model.disconnectAndWait()
    }

    @Test func tappingAnAlertOpensItsThread() async throws {
        let (coordinator, _, _) = try await connected()
        await coordinator.respond(action: "com.apple.UNNotificationDefaultActionIdentifier", notificationId: "n:7", info: approvalInfo)
        #expect(coordinator.model?.deepLink == "thread")
    }

    @Test func eachMachineKeepsItsOwnCatchUpAndAnAnswerGoesToTheMachineThatRaisedTheAlert() async throws {
        let center = FakeCenter()
        let sessions = Sessions()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        await coordinator.setEnabled(true)
        for host in ["studio", "laptop"] {
            let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
            await coordinator.attach(model, target: try target(host))
            await model.connect(target: try target(host), directory: URL(fileURLWithPath: "/unused"))
        }
        let (studio, laptop) = (sessions.values[0], sessions.values[1])
        for session in [studio, laptop] { session.patch(#"{"type":"connection","state":"ready"}"#) }
        // The same alert id from two daemons is two alerts, each tagged with its machine.
        let alert = #"{"id":"n:1","threadId":"thread","title":"Fix","status":"needs_you","interactionId":"push","backgroundCount":0,"actions":[{"action":"approve","optionId":"allow"},{"action":"deny","optionId":"deny"}]}"#
        laptop.patch(#"{"type":"notifications.feed","cursor":9,"entries":[\#(alert)],"retracted":[]}"#)
        studio.patch(#"{"type":"notifications.alert","notification":\#(alert)}"#)
        // The machines post independently, in no promised order: one alert each, each its own.
        try await until("both machines' alerts posted") { center.posted.count == 2 }
        #expect(center.posted.filter { $0.hostId == "laptop" }.count == 1)
        #expect(center.posted.filter { $0.hostId == "studio" }.count == 1)
        #expect(Set(center.posted.map(\.identifier)).count == 2)
        // Only the laptop's catch-up cursor moved: the next sync tells each machine its own.
        coordinator.sync()
        #expect(laptop.actions("notifications.sync").last?["cursor"] as? Int == 9)
        #expect(studio.actions("notifications.sync").last?["cursor"] as? Int == 0)

        var info = approvalInfo
        info[NotificationKeys.hostId] = "laptop"
        let response = Task { await coordinator.respond(action: NotificationActionID.approve, notificationId: "n:1", info: info) }
        _ = try await laptop.waitFor("notifications.resolve")
        #expect(studio.actions("notifications.resolve").isEmpty)
        laptop.patch(#"{"type":"notifications.action","id":"tap-1","outcome":"confirmed"}"#)
        await response.value
        // The laptop's notification goes; the studio's stays.
        #expect(center.delivered.values.map(\.hostId) == ["studio"])
    }

    @Test func theSameAlertIdFromTwoMachinesShowsTwiceAndRetractingOneLeavesTheOther() async throws {
        let center = FakeCenter()
        let store = try defaults()
        let studio = LocalNotifier(center: center, hostId: "studio")
        studio.bind(LedgerStore(scope: "studio", defaults: store))
        let laptop = LocalNotifier(center: center, hostId: "laptop")
        laptop.bind(LedgerStore(scope: "laptop", defaults: store))
        await studio.receive(alert("n:1"))
        await laptop.receive(alert("n:1"))
        #expect(Set(center.delivered.values.compactMap(\.hostId)) == ["studio", "laptop"])
        await laptop.catchUp(cursor: 1, entries: [], retracted: ["n:1"])
        #expect(center.delivered.values.map(\.hostId) == ["studio"])
    }

    @Test func aSecondAlertForTheSameThreadReplacesTheFirstInsteadOfStacking() async throws {
        let center = FakeCenter()
        let notifier = LocalNotifier(center: center, hostId: "studio")
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        await notifier.receive(alert("n:1", status: "needs_you"))
        await notifier.receive(alert("n:2", status: "done"))
        #expect(center.delivered.count == 1)
        #expect(center.delivered.values.first?.body.hasPrefix("Done") == true)
    }

    @Test func threeThreadsFinishingInsideTheWindowBecomeOneQuietSummary() async throws {
        let center = FakeCenter()
        var clock = 1_000_000.0
        let desk = AlertDesk(center: center, now: { clock })
        let notifier = LocalNotifier(center: center, hostId: "studio", desk: desk)
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        await notifier.receive(alert("n:1", thread: "a", title: "Fix stalls"))
        // The first finish sounds on its own.
        #expect(center.delivered.values.map(\.level) == [.active])
        clock += 30_000
        await notifier.receive(alert("n:2", thread: "b", title: "Polish the composer"))
        clock += 30_000
        await notifier.receive(alert("n:3", thread: "c", title: "Ship the widget"))
        let shown = try #require(center.delivered.values.first)
        #expect(center.delivered.count == 1)
        #expect(shown.title == "3 threads finished")
        #expect(shown.body == "Ship the widget, Polish the composer, Fix stalls")
        #expect(shown.level == .passive)
        // A finish well after the burst is its own notification again.
        clock += AlertStack.burstWindow + 60_000
        await notifier.receive(alert("n:4", thread: "d", title: "Later"))
        #expect(center.delivered.count == 2)
    }

    @Test func aFailureOrRequestNeverFoldsIntoTheFinishedSummary() async throws {
        let center = FakeCenter()
        let notifier = LocalNotifier(center: center, hostId: "studio", desk: AlertDesk(center: center, now: { 0 }))
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        await notifier.receive(alert("n:1", thread: "a"))
        await notifier.receive(alert("n:2", status: "failed", thread: "b"))
        await notifier.receive(alert("n:3", status: "needs_you", thread: "c"))
        #expect(center.delivered.count == 3)
    }

    @Test func openingAThreadOnThePhoneWithdrawsItsNotification() async throws {
        let (coordinator, center, session) = try await connected()
        await coordinator.setEnabled(true)
        session.patch(#"{"type":"notifications.alert","notification":{"id":"n:1","threadId":"thread","title":"Fix","status":"done","backgroundCount":0,"actions":[]}}"#)
        try await until("the alert posted") { center.delivered.count == 1 }
        coordinator.model?.open("thread")
        #expect(center.delivered.isEmpty)
    }

    // MARK: Telling the bridge a live alert was handled (its ack, ADR 0106)

    @Test func aLiveAlertIsReportedDeliveredOnlyOnceNotificationCenterHasIt() async throws {
        let (coordinator, center, session) = try await connected(HeldCenter())
        await coordinator.setEnabled(true)
        session.patch(#"{"type":"notifications.alert","notification":{"id":"n:1","threadId":"thread","title":"Fix","status":"done","backgroundCount":0,"actions":[]}}"#)
        try await until("the post is under way") { center.holding }
        for _ in 0..<20 { await Task.yield() }
        // Suspended now, nothing would show: the daemon must still push it.
        #expect(session.actions("notifications.delivered").isEmpty)
        center.release()
        #expect(try await session.waitFor("notifications.delivered")["id"] as? String == "n:1")
        #expect(center.delivered.count == 1)
    }

    @Test func aLiveAlertThePhonesOwnSettingsDontPostIsStillReportedDelivered() async throws {
        let (coordinator, center, session) = try await connected()
        await coordinator.setEnabled(true)
        session.patch(#"{"type":"notifications.alert","notification":{"id":"n:1","threadId":"thread","title":"Fix","status":"done","backgroundCount":0,"actions":[],"delivery":{"post":false,"interrupt":false,"banner":false}}}"#)
        #expect(try await session.waitFor("notifications.delivered")["id"] as? String == "n:1")
        #expect(center.posted.isEmpty)
    }

    @Test func aLiveAlertForAMachineTurnedOffHereIsReportedDeliveredAndNotPosted() async throws {
        let (coordinator, center, session) = try await connected()
        await coordinator.setEnabled(true)
        coordinator.setMachine("host", enabled: false)
        session.patch(#"{"type":"notifications.alert","notification":{"id":"n:1","threadId":"thread","title":"Fix","status":"done","backgroundCount":0,"actions":[]}}"#)
        #expect(try await session.waitFor("notifications.delivered")["id"] as? String == "n:1")
        #expect(center.posted.isEmpty)
    }

    @Test func aLiveAlertAPushAlreadyShowedIsReportedDeliveredAndPostedAgainQuietly() async throws {
        let center = FakeCenter()
        let sessions = Sessions()
        let pushed = PushedAlerts(defaults: try defaults())
        pushed.record(AlertContent.requestId("n:1", hostId: "host"))
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, connectInBackground: { _ in [] }, pushed: pushed)
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(model, target: try target())
        await model.connect(target: try target(), directory: URL(fileURLWithPath: "/unused"))
        let session = try #require(sessions.values.first)
        session.patch(#"{"type":"connection","state":"ready"}"#)
        try await until("the connection is ready") { model.connection == "ready" }
        await coordinator.setEnabled(true)
        session.patch(#"{"type":"notifications.alert","notification":{"id":"n:1","threadId":"thread","title":"Fix","status":"done","backgroundCount":0,"actions":[]}}"#)
        #expect(try await session.waitFor("notifications.delivered")["id"] as? String == "n:1")
        #expect(center.posted.map(\.level) == [.passive])
    }

    @Test func aLiveCopyOfAnAlertCatchUpIsStillPostingIsNotReportedDeliveredUntilItLands() async throws {
        let (coordinator, center, session) = try await connected(HeldCenter())
        await coordinator.setEnabled(true)
        session.patch(#"{"type":"notifications.feed","cursor":1,"entries":[{"id":"n:1","threadId":"thread","title":"Fix","status":"needs_you","backgroundCount":0,"actions":[]}],"retracted":[]}"#)
        try await until("catch-up's post is under way") { center.holding }
        session.patch(#"{"type":"notifications.alert","notification":{"id":"n:1","threadId":"thread","title":"Fix","status":"needs_you","backgroundCount":0,"actions":[]}}"#)
        for _ in 0..<20 { await Task.yield() }
        // Nothing has landed yet: suspended now, only the push would show it.
        #expect(session.actions("notifications.delivered").isEmpty)
        center.release()
        #expect(try await session.waitFor("notifications.delivered")["id"] as? String == "n:1")
        #expect(center.delivered.count == 1)
    }

    @Test func aRequestAnsweredElsewhereTakesItsNotificationWithItOnceTheRowMovesOn() async throws {
        let (coordinator, center, session) = try await connected()
        await coordinator.setEnabled(true)
        session.patch(#"{"type":"notifications.alert","notification":{"id":"n:1","threadId":"thread","title":"Fix","status":"needs_you","interactionId":"push","backgroundCount":0,"actions":[]}}"#)
        try await until("the alert posted") { center.delivered.count == 1 }
        session.patch(#"{"type":"inbox.row","id":"thread","row":{"id":"thread","title":"Fix","state":"working","attention":null,"project":"ace","branch":"","machine":"","provider":"codex","model":"","agents":1,"snoozedUntil":null,"updatedAt":1,"canSteer":true,"status":{"label":"Working","token":"working"},"machineId":"host","activityAt":1,"confirmed":true,"generation":0,"look":{"level":"active","state":"working","tone":"working","muted":true,"settled":false,"subagents":0}}}"#)
        try await until("the answered request's notification goes") { center.delivered.isEmpty }
    }

    // MARK: Alerts a push showed while ace was closed (ADR 0106)

    @Test func aPushedFinishGoesWhenTheSameThreadAsksForThePersonLater() async throws {
        let center = FakeCenter()
        let pushed = PushedAlerts(defaults: try defaults())
        let notifier = LocalNotifier(center: center, hostId: "studio", desk: AlertDesk(center: center, now: { 0 }, pushed: pushed))
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        center.push(alert("n:1"), hostId: "studio", apnsId: "apns-1", pushed: pushed)
        // Reopened: catch-up brings the finish, which the push already showed.
        await notifier.catchUp(cursor: 1, entries: [alert("n:1")], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Done"])
        await notifier.receive(alert("n:2", status: "needs_you", actions: true))
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func twoPushesForOneThreadWhileClosedLeaveOnlyTheNewerAfterCatchUp() async throws {
        let center = FakeCenter()
        let pushed = PushedAlerts(defaults: try defaults())
        let notifier = LocalNotifier(center: center, hostId: "studio", desk: AlertDesk(center: center, now: { 0 }, pushed: pushed))
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        center.push(alert("n:1"), hostId: "studio", apnsId: "apns-1", pushed: pushed)
        center.push(alert("n:2", status: "needs_you", actions: true), hostId: "studio", apnsId: "apns-2", pushed: pushed)
        await notifier.catchUp(cursor: 2, entries: [alert("n:1"), alert("n:2", status: "needs_you", actions: true)], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
        // Both were seen from their pushes: in place again without another sound.
        #expect(center.posted.allSatisfy { $0.level == .passive })
    }

    @Test func anOlderAlertThatWasNeverPushedLeavesTheNewerPushedOneShown() async throws {
        let center = FakeCenter()
        let pushed = PushedAlerts(defaults: try defaults())
        let notifier = LocalNotifier(center: center, hostId: "studio", desk: AlertDesk(center: center, now: { 0 }, pushed: pushed))
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        center.push(alert("n:2", status: "needs_you", actions: true), hostId: "studio", apnsId: "apns-2", pushed: pushed)
        await notifier.catchUp(cursor: 2, entries: [alert("n:1"), alert("n:2", status: "needs_you", actions: true)], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func aNewerPushStaysShownAfterTheOlderOneLeftThePushHistory() async throws {
        let center = FakeCenter()
        let pushed = PushedAlerts(defaults: try defaults())
        let notifier = LocalNotifier(center: center, hostId: "studio", desk: AlertDesk(center: center, now: { 0 }, pushed: pushed))
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        center.push(alert("n:1", status: "agent_says"), hostId: "studio", apnsId: "apns-1", pushed: pushed)
        // Other machines' pushes push n:1 out of the bounded history.
        for index in 0..<PushedAlerts.capacity { pushed.record("other:\(index)") }
        center.push(alert("n:2", status: "needs_you", actions: true), hostId: "studio", apnsId: "apns-2", pushed: pushed)
        await notifier.catchUp(cursor: 2, entries: [alert("n:1", status: "agent_says"), alert("n:2", status: "needs_you", actions: true)],
                               retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func catchUpNeverPutsAnOlderFinishOverANewerRequestThatArrivedLive() async throws {
        let (notifier, center) = try plainNotifier()
        // Live while catch-up's read was out: the request is newer than the finish before it.
        await notifier.receive(alert("n:2", status: "needs_you", actions: true))
        await notifier.catchUp(cursor: 2, entries: [alert("n:1"), alert("n:2", status: "needs_you", actions: true)], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func aLiveAlertTheFeedDoesNotHoldYetStaysOverTheFeedsOlderOnes() async throws {
        let (notifier, center) = try plainNotifier()
        await notifier.receive(alert("n:3", status: "needs_you", actions: true))
        await notifier.catchUp(cursor: 2, entries: [alert("n:1"), alert("n:2", status: "failed")], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func catchUpShowsOnlyEachThreadsNewestMissedAlert() async throws {
        let (notifier, center) = try plainNotifier()
        await notifier.catchUp(cursor: 2, entries: [alert("n:1", status: "needs_you", actions: true), alert("n:2")], retracted: [])
        #expect(center.posted.map(\.body) == ["Done"])
    }

    @Test func aMissedFinishThisPhoneDoesntPostNeverHidesTheRequestBeforeIt() async throws {
        let (notifier, center) = try plainNotifier()
        var finish = alert("n:2", status: "background_done")
        finish.delivery = .init(post: false, interrupt: false, banner: false)
        await notifier.catchUp(cursor: 2, entries: [alert("n:1", status: "needs_you", actions: true), finish], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func aLiveAlertThisPhoneDoesntPostHoldsNothingBack() async throws {
        let (notifier, center) = try plainNotifier()
        var finish = alert("n:3", status: "background_done")
        finish.delivery = .init(post: false, interrupt: false, banner: false)
        await notifier.receive(finish)
        await notifier.catchUp(cursor: 2, entries: [alert("n:2", status: "needs_you", actions: true)], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func aLiveRequestStaysOverOlderAlertsAcrossTwoCatchUps() async throws {
        let (notifier, center) = try plainNotifier()
        // The first feed was read before the request arrived live, and doesn't hold it.
        await notifier.receive(alert("n:3", status: "needs_you", actions: true))
        await notifier.catchUp(cursor: 1, entries: [], retracted: [])
        await notifier.catchUp(cursor: 3, entries: [alert("n:2", status: "background_done"), alert("n:3", status: "needs_you", actions: true)],
                               retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func aLiveRequestNoFeedHoldsYetKeepsHoldingOlderAlertsBack() async throws {
        let (notifier, center) = try plainNotifier()
        await notifier.receive(alert("n:3", status: "needs_you", actions: true))
        await notifier.catchUp(cursor: 1, entries: [], retracted: [])
        // Still read before the request arrived: its older finish must not cover it.
        await notifier.catchUp(cursor: 2, entries: [alert("n:2", status: "failed")], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func aLiveAlertTheDaemonDroppedNeverHoldsBackANewerOneFromTheFeed() async throws {
        let (notifier, center) = try plainNotifier()
        await notifier.receive(cursored(alert("n:5"), 5))
        // The daemon's inbox let n:5 go without a retraction; the feed brings a newer request.
        await notifier.catchUp(cursor: 7, entries: [cursored(alert("n:7", status: "needs_you", actions: true), 7)], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func aFeedAlertWithALowerCursorNeverCoversALiveRequest() async throws {
        let (notifier, center) = try plainNotifier()
        await notifier.receive(cursored(alert("n:3", status: "needs_you", actions: true), 3))
        await notifier.catchUp(cursor: 3, entries: [cursored(alert("n:2", status: "failed"), 2)], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func aNewConnectionStopsHoldingBackTheLastOnesLiveAlerts() async throws {
        let (notifier, center) = try plainNotifier()
        await notifier.receive(cursored(alert("n:a", status: "needs_you", actions: true), 500))
        // The daemon's database was rebuilt and its cursors started over.
        notifier.connected()
        await notifier.catchUp(cursor: 3, entries: [cursored(alert("n:b", status: "failed"), 3)], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Failed"])
    }

    @Test func aReconnectMidCatchUpStillKeepsThatFeedsOlderFinishOffALiveRequest() async throws {
        let center = HeldCenter()
        let notifier = LocalNotifier(center: center, hostId: "studio")
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        let request = Task { await notifier.receive(cursored(alert("n:3", status: "needs_you", actions: true), 3)) }
        try await until("the live request is landing") { center.holding }
        let feed = Task {
            await notifier.catchUp(cursor: 2, entries: [cursored(alert("n:1", status: "failed", thread: "other"), 1), cursored(alert("n:2"), 2)],
                                   retracted: [])
        }
        try await until("the feed is applying") { notifier.ledger.cursor == 2 }
        notifier.connected()
        center.release()
        await request.value
        await feed.value
        #expect(center.delivered.values.map(\.body).sorted() == ["Failed", "Needs you"])
    }

    @Test func aReconnectWhileAFeedWaitsItsTurnStillKeepsItsOlderFinishOffALiveRequest() async throws {
        let center = HeldCenter()
        let notifier = LocalNotifier(center: center, hostId: "studio")
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        // An earlier feed is still posting when the request arrives live and the next feed comes.
        let earlier = Task { await notifier.catchUp(cursor: 1, entries: [cursored(alert("n:1", status: "failed", thread: "other"), 1)], retracted: []) }
        try await until("the earlier feed is posting") { center.holding }
        let request = Task { await notifier.receive(cursored(alert("n:3", status: "needs_you", actions: true), 3)) }
        for _ in 0..<20 { await Task.yield() }
        let queued = Task { await notifier.catchUp(cursor: 2, entries: [cursored(alert("n:2"), 2)], retracted: []) }
        for _ in 0..<20 { await Task.yield() }
        notifier.connected()
        center.release()
        await earlier.value
        await request.value
        await queued.value
        #expect(center.delivered.values.map(\.body).sorted() == ["Failed", "Needs you"])
    }

    @Test func aLiveAlertAnEarlierFeedCoveredNeverHoldsBackAQueuedFeedsNewerRequest() async throws {
        let center = HeldCenter()
        let notifier = LocalNotifier(center: center, hostId: "studio")
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        // No cursors, as from an older daemon: the feeds' order decides.
        let done = Task { await notifier.receive(alert("n:2")) }
        try await until("the live finish is posting") { center.holding }
        let earlier = Task { await notifier.catchUp(cursor: 2, entries: [alert("n:1", status: "failed", thread: "other"), alert("n:2")], retracted: []) }
        for _ in 0..<20 { await Task.yield() }
        let later = Task { await notifier.catchUp(cursor: 3, entries: [alert("n:3", status: "needs_you", actions: true)], retracted: []) }
        for _ in 0..<20 { await Task.yield() }
        center.release()
        await done.value
        await earlier.value
        await later.value
        #expect(center.delivered.values.map(\.body).sorted() == ["Failed", "Needs you"])
    }

    @Test func aLaterCatchUpWaitsForAnEarlierOneThatIsStillPosting() async throws {
        let center = HeldCenter()
        let notifier = LocalNotifier(center: center, hostId: "studio")
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        let earlier = Task { await notifier.catchUp(cursor: 2, entries: [alert("n:1", status: "failed", thread: "other"), alert("n:2")], retracted: []) }
        try await until("the first feed's first post is out") { center.holding }
        let later = Task { await notifier.catchUp(cursor: 3, entries: [alert("n:3", status: "needs_you", actions: true)], retracted: []) }
        for _ in 0..<20 { await Task.yield() }
        center.release()
        await earlier.value
        await later.value
        #expect(center.delivered.values.map(\.body).sorted() == ["Failed", "Needs you"])
    }

    @Test func aRetractionInALaterFeedWithdrawsWhatAnEarlierFeedStillHadToPost() async throws {
        let center = HeldCenter()
        let notifier = LocalNotifier(center: center, hostId: "studio")
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        let earlier = Task { await notifier.catchUp(cursor: 2, entries: [alert("n:1", status: "failed", thread: "other"), alert("n:2")], retracted: []) }
        try await until("the first feed's first post is out") { center.holding }
        let later = Task { await notifier.catchUp(cursor: 3, entries: [], retracted: ["n:2"]) }
        for _ in 0..<20 { await Task.yield() }
        center.release()
        await earlier.value
        await later.value
        #expect(center.delivered.values.map(\.body) == ["Failed"])
    }


    @Test func aFeedWhoseNewestForAThreadWasAlreadySeenLandsNothingOlderForIt() async throws {
        let (notifier, center) = try plainNotifier()
        await notifier.receive(alert("n:2", status: "needs_you", actions: true))
        // A later catch-up, with no live alert pending, still holds both.
        await notifier.catchUp(cursor: 2, entries: [alert("n:2", status: "needs_you", actions: true)], retracted: [])
        await notifier.catchUp(cursor: 2, entries: [alert("n:1"), alert("n:2", status: "needs_you", actions: true)], retracted: [])
        #expect(center.delivered.values.map(\.body) == ["Needs you"])
    }

    @Test func aRetractedLiveAlertNoLongerHoldsBackTheFeed() async throws {
        let (notifier, center) = try plainNotifier()
        await notifier.receive(alert("n:2", status: "needs_you", actions: true))
        await notifier.catchUp(cursor: 2, entries: [alert("n:1", status: "failed")], retracted: ["n:2"])
        #expect(center.delivered.values.map(\.body) == ["Failed"])
    }

    @Test func aCopyWaitingOnALandingIsReleasedEvenAfterTheLedgerLetItsIdGo() async throws {
        let center = HeldCenter()
        let notifier = LocalNotifier(center: center, hostId: "studio")
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        let returned = Returns()
        Task { await notifier.receive(alert("n:1")) }
        try await until("the first copy is landing") { center.holding }
        Task { await notifier.receive(alert("n:1")); returned.count += 1 }
        for _ in 0..<20 { await Task.yield() }
        // More alerts than the ledger keeps, none posted: n:1 leaves the ledger.
        let quiet = (0...NotificationLedger.capacity).map { index -> AlertNotification in
            var other = alert("other:\(index)", thread: "other-\(index)")
            other.delivery = .init(post: false, interrupt: false, banner: false)
            return other
        }
        await notifier.catchUp(cursor: 1, entries: quiet, retracted: [])
        Task { await notifier.receive(alert("n:1")); returned.count += 1 }
        for _ in 0..<20 { await Task.yield() }
        center.release()
        try await until("both later copies return") { returned.count == 2 }
    }

    @Test func anotherThreadsPushIsLeftAlone() async throws {
        let center = FakeCenter()
        let pushed = PushedAlerts(defaults: try defaults())
        let notifier = LocalNotifier(center: center, hostId: "studio", desk: AlertDesk(center: center, now: { 0 }, pushed: pushed))
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        center.push(alert("n:1", status: "failed", thread: "other"), hostId: "studio", apnsId: "apns-1", pushed: pushed)
        await notifier.receive(alert("n:2", status: "needs_you", actions: true))
        #expect(center.delivered.count == 2)
    }

    @Test func aRetractionAlsoWithdrawsTheBareIdAnOlderBuildPosted() async throws {
        let center = FakeCenter()
        await center.post(AlertContent(alert("n:1")))
        let notifier = LocalNotifier(center: center, hostId: "studio")
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        await notifier.catchUp(cursor: 1, entries: [], retracted: ["n:1"])
        #expect(center.delivered.isEmpty)
    }

    @Test func aNeedsYouAlertSaysWhoAsksAndAShortQuestionGetsItsOptionsAsButtons() {
        var ask = alert("n:1", status: "needs_you")
        ask = AlertNotification(id: ask.id, threadId: ask.threadId, title: "Review the blog", status: "needs_you", interactionId: "ask",
                                backgroundCount: 0, actions: [], preview: nil, message: nil,
                                request: .init(kind: "question", sentence: "Claude Code has a question", detail: "Include the archive?", code: false,
                                               questionId: "scope", choices: [.init(id: "yes", label: "Include it"), .init(id: "no", label: "Skip it")], reply: true))
        let content = AlertContent(ask)
        #expect(content.title == "Claude Code has a question")
        #expect(content.body == "Review the blog · Include the archive?")
        #expect(content.category == NotificationCategories.choiceId(["Include it", "Skip it"], reply: true))
        #expect(content.choices.map(\.id) == ["yes", "no"])
        #expect(content.takesWords)
        // A finished thread takes a reply; an unknown status stays a plain tap.
        #expect(AlertContent(alert("n:2", status: "done")).category == AlertContent.replyCategory)
        #expect(AlertContent(alert("n:3", status: "something_new")).category == AlertContent.threadCategory)
    }

    @Test func anOptionTappedOnTheNotificationAnswersThatOptionAndTheAlertGoesOnceConfirmed() async throws {
        let (coordinator, center, session) = try await connected()
        var info = approvalInfo
        info[NotificationKeys.questionId] = "scope"
        info[NotificationKeys.choices] = "yes\u{1F}no"
        let response = Task { await coordinator.respond(action: NotificationActionID.choice(1), notificationId: "n:8", info: info) }
        let answer = try await session.waitFor("notifications.answer")
        #expect(answer["value"] as? String == "no")
        #expect(answer["questionId"] as? String == "scope")
        session.patch(#"{"type":"notifications.action","id":"tap-1","outcome":"confirmed"}"#)
        await response.value
        #expect(center.withdrawn == ["n:8"])
        #expect(center.posted.isEmpty)
    }

    @Test func aReplyTheMachineRefusesComesBackQuietlyWithTheWordsSoTheyArentLost() async throws {
        let (coordinator, center, session) = try await connected()
        let response = Task {
            await coordinator.respond(action: NotificationActionID.reply, notificationId: "n:9", info: [NotificationKeys.threadId: "thread"],
                                      text: "  Also run the linter ")
        }
        let reply = try await session.waitFor("notifications.reply")
        #expect(reply["text"] as? String == "Also run the linter")
        session.patch(#"{"type":"notifications.action","id":"tap-1","outcome":"refused"}"#)
        await response.value
        #expect(center.posted.map(\.title) == ["Message not sent"])
        #expect(center.posted.first?.body.contains("“Also run the linter”") == true)
        #expect(center.posted.first?.level == .passive)
    }

    @Test func anApprovalAnsweredElsewhereSaysSoInsteadOfGoingSilent() async throws {
        let (coordinator, center, session) = try await connected()
        let response = Task { await coordinator.respond(action: NotificationActionID.approve, notificationId: "n:7", info: approvalInfo) }
        _ = try await session.waitFor("notifications.resolve")
        session.patch(#"{"type":"notifications.action","id":"tap-1","outcome":"stale"}"#)
        await response.value
        #expect(center.withdrawn == ["n:7"])
        #expect(center.posted.map(\.title) == ["Already answered"])
    }

    @Test func anEmptyReplyOpensTheThreadInsteadOfSendingNothing() async throws {
        let (coordinator, _, session) = try await connected()
        await coordinator.respond(action: NotificationActionID.reply, notificationId: "n:9", info: [NotificationKeys.threadId: "thread"], text: "  ")
        #expect(session.actions("notifications.reply").isEmpty)
        #expect(coordinator.model?.deepLink == "thread")
    }

    @Test func anAlertHandedOverJustBeforeItsMachineIsTurnedOffNeverLandsAndIsNotPostedLater() async throws {
        let center = FakeCenter()
        let sessions = Sessions()
        let store = try defaults()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: store, now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        await coordinator.setEnabled(true)
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(model, target: try target("studio"))
        // The alert's task is queued, then the machine is turned off before it runs.
        coordinator.receive(.alert(alert("n:1")), from: "studio")
        coordinator.turnedOff("studio")
        for _ in 0..<50 { await Task.yield() }
        try await Task.sleep(for: .milliseconds(20))
        #expect(center.posted.isEmpty)
        #expect(AlertStack.load(store).shown.isEmpty)
        // On again: the alert was counted, so the same alert is never posted late.
        let again = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(again, target: try target("studio"))
        coordinator.receive(.alert(alert("n:1")), from: "studio")
        coordinator.receive(.alert(alert("n:2", thread: "other")), from: "studio")
        try await until("the new alert posted") { center.posted.count == 1 }
        #expect(center.posted.map(\.threadId) == ["other"])
    }

    @Test func aCatchUpWhoseFirstPostIsStillOutWhenTheMachineIsTurnedOffLandsNothingMore() async throws {
        let center = HeldCenter()
        let sessions = Sessions()
        let store = try defaults()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: store, now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        await coordinator.setEnabled(true)
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(model, target: try target("studio"))
        await model.connect(target: try target("studio"), directory: URL(fileURLWithPath: "/unused"))
        let session = try #require(sessions.values.first)
        coordinator.receive(.feed(cursor: 7, entries: [alert("n:1", thread: "t1"), alert("n:2", thread: "t2")], retracted: []),
                            from: "studio")
        try await until("the first post is out") { center.holding }
        coordinator.turnedOff("studio")
        center.release()
        try await Task.sleep(for: .milliseconds(30))
        for _ in 0..<50 { await Task.yield() }
        // The first was withdrawn once it landed; the second, and the summary it would fold into, never came.
        #expect(center.delivered.isEmpty)
        #expect(!center.posted.contains { $0.threadId == "t2" })
        #expect(AlertStack.load(store).shown.isEmpty)
        // The catch-up cursor still moved past both.
        coordinator.sync()
        #expect(session.actions("notifications.sync").last?["cursor"] as? Int == 7)
        await model.disconnectAndWait()
    }

    @Test func anAlertStillOutWhenItsMachineIsLetGoIsWithdrawnOnceItLandsAndNothingStaysShown() async throws {
        let center = HeldCenter()
        let sessions = Sessions()
        let store = try defaults()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: store, now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        await coordinator.setEnabled(true)
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(model, target: try target("studio"))
        coordinator.receive(.alert(alert("n:1", thread: "t1")), from: "studio")
        try await until("the post is out") { center.holding }
        // Let go (removed, or taken in by the machine it turned out to be) while the post is out.
        coordinator.detach(model)
        center.release()
        try await Task.sleep(for: .milliseconds(30))
        for _ in 0..<50 { await Task.yield() }
        #expect(center.posted.map(\.threadId) == ["t1"])
        #expect(center.delivered.isEmpty)
        #expect(AlertStack.load(store).shown.isEmpty)
    }

    @Test func anAlertQueuedBehindAnotherWhenItsMachineIsLetGoIsNeverPosted() async throws {
        let center = HeldCenter()
        let sessions = Sessions()
        let store = try defaults()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: store, now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        await coordinator.setEnabled(true)
        let studio = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        let office = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(office, target: try target("office"))
        await coordinator.attach(studio, target: try target("studio"))
        // Another machine's post is out; the studio's waits behind it.
        coordinator.receive(.alert(alert("n:1", status: "needs_you", thread: "o1")), from: "office")
        try await until("the first post is out") { center.holding }
        coordinator.receive(.alert(alert("n:2", status: "needs_you", thread: "s1")), from: "studio")
        try await until("the studio's alert is on the stack") { AlertStack.load(store).shown.count == 2 }
        coordinator.detach(studio)
        center.release()
        try await Task.sleep(for: .milliseconds(30))
        for _ in 0..<50 { await Task.yield() }
        #expect(center.posted.map(\.threadId) == ["o1"])
        #expect(AlertStack.load(store).shown.map(\.threadId) == ["o1"])
    }

    // MARK: Support

    private let approvalInfo = [NotificationKeys.threadId: "thread", NotificationKeys.interactionId: "push",
                                NotificationKeys.approve: "allow", NotificationKeys.deny: "deny"]
    private func connected() async throws -> (NotificationCoordinator, FakeCenter, Session) { try await connected(FakeCenter()) }
    private func connected<Center: NotificationCenterPort>(_ center: Center) async throws -> (NotificationCoordinator, Center, Session) {
        let sessions = Sessions()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(model, target: try target())
        await model.connect(target: try target(), directory: URL(fileURLWithPath: "/unused"))
        let session = try #require(sessions.values.first)
        session.patch(#"{"type":"connection","state":"ready"}"#)
        try await until("the connection is ready") { model.connection == "ready" }
        return (coordinator, center, session)
    }
    private func cursored(_ alert: AlertNotification, _ cursor: Int) -> AlertNotification {
        var alert = alert
        alert.cursor = cursor
        return alert
    }
    private func plainNotifier() throws -> (LocalNotifier, FakeCenter) {
        let center = FakeCenter()
        let notifier = LocalNotifier(center: center, hostId: "studio")
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        return (notifier, center)
    }
    private func defaults() throws -> UserDefaults { try #require(UserDefaults(suiteName: "ace.tests.\(UUID().uuidString)")) }
    private func target(_ host: String = "host") throws -> ConnectionTarget {
        ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:9841")), hostId: host, deviceId: "phone", pin: nil, credential: { "{}" })
    }
    private func alert(_ id: String, status: String = "done", actions: Bool = false, thread: String = "thread",
                       title: String = "Fix the flaky queue test") -> AlertNotification {
        AlertNotification(id: id, threadId: thread, title: title, status: status,
                          interactionId: actions ? "push" : nil, backgroundCount: 0,
                          actions: actions ? [.init(action: "approve", optionId: "allow"), .init(action: "deny", optionId: "deny")] : [],
                          preview: nil, message: nil)
    }
}

/// Waits for `condition` on the main actor, by the clock, failing after `seconds` with `label`.
/// Patches reach the coordinator through tasks, so a test waits on what it needs, never on a count
/// of turns.
@MainActor private func until(_ label: String, seconds: Int = 10, _ condition: () -> Bool) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(seconds))
    while !condition() {
        if clock.now >= deadline { throw WaitTimeout(label: label) }
        try await Task.sleep(for: .milliseconds(5))
    }
}
private struct WaitTimeout: Error, CustomStringConvertible {
    let label: String
    var description: String { "Timed out waiting for \(label)" }
}

/// Polling steps pass at once; long deadlines never fire during a test.
private let fastSleep: @Sendable (Duration) async -> Void = { duration in
    if duration < .seconds(1) { await Task.yield() } else { try? await Task.sleep(for: .seconds(60)) }
}
private final class FakeCenter: NotificationCenterPort, @unchecked Sendable {
    var posted: [AlertContent] = []
    var withdrawn: [String] = []
    /// What Notification Center shows: a post replaces any with the same identifier.
    var delivered: [String: AlertContent] = [:]
    /// The service extension's copies among `delivered`, by APNs identifier: the alert each is
    /// (`pushedAlert`) and the thread it stands for (`standsFor`).
    private var pushes: [String: (alert: String, standsFor: String)] = [:]
    func post(_ content: AlertContent) async { posted.append(content); delivered[content.identifier] = content }
    func withdraw(_ identifiers: [String]) {
        withdrawn.append(contentsOf: identifiers)
        for id in identifiers { delivered.removeValue(forKey: id) }
        let wanted = Set(identifiers)
        remove(pushes.filter { wanted.contains($0.value.alert) || wanted.contains($0.value.standsFor) }.keys)
    }
    func withdrawPushed(standingFor thread: String) {
        remove(pushes.filter { $0.value.standsFor == thread }.keys)
    }
    /// What `AceNotificationService` does with a push while ace is closed: shows the alert under
    /// APNs' identifier and notes it in `PushedAlerts`.
    func push(_ alert: AlertNotification, hostId: String, apnsId: String, pushed: PushedAlerts) {
        let content = AlertContent(alert, hostId: hostId)
        delivered[apnsId] = content
        pushes[apnsId] = (content.identifier, AlertStack.thread(alert.threadId, hostId: hostId))
        pushed.record(content.identifier)
    }
    private func remove(_ ids: some Sequence<String>) { for id in Array(ids) { pushes[id] = nil; delivered[id] = nil } }
}
/// Holds the first post open until released, as a slow Notification Center would.
private final class HeldCenter: NotificationCenterPort, @unchecked Sendable {
    private let lock = NSLock()
    private var gate: CheckedContinuation<Void, Never>?
    private var first = true
    private var posts: [AlertContent] = []
    private var shown: [String: AlertContent] = [:]
    var holding: Bool { lock.withLock { gate != nil } }
    var posted: [AlertContent] { lock.withLock { posts } }
    var delivered: [String: AlertContent] { lock.withLock { shown } }
    func post(_ content: AlertContent) async {
        let hold = lock.withLock { () -> Bool in defer { first = false }; return first }
        if hold { await withCheckedContinuation { continuation in lock.withLock { gate = continuation } } }
        lock.withLock { posts.append(content); shown[content.identifier] = content }
    }
    func release() { lock.withLock { let held = gate; gate = nil; return held }?.resume() }
    func withdraw(_ identifiers: [String]) { lock.withLock { for id in identifiers { shown.removeValue(forKey: id) } } }
    func withdrawPushed(standingFor thread: String) {}
}
private struct FakeAuthorizer: NotificationAuthorizer {
    func status() async -> NotificationCoordinator.Permission { .allowed }
    func request() async -> Bool { true }
}
@MainActor private final class Sessions {
    var values: [Session] = []
    func make(_ target: ConnectionTarget, _ storage: URL, _ receive: @escaping @Sendable (Data) -> Void,
              _ fail: @escaping @Sendable (String) -> Void) -> any ClientSession {
        let session = Session(receive: receive)
        values.append(session)
        return session
    }
}
/// Only the JavaScriptCore boundary is substituted: actions out, patches in.
private final class Session: ClientSession, @unchecked Sendable {
    private let receive: @Sendable (Data) -> Void
    private let lock = NSLock()
    private var invoked: [[String: Any]] = []
    init(receive: @escaping @Sendable (Data) -> Void) { self.receive = receive }
    func start(itemLimit: Int) {}
    func invoke(_ name: String, json: String) {
        guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
        lock.withLock { invoked.append(value) }
    }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
    func patch(_ json: String) { receive(Data("[\(json)]".utf8)) }
    func actions(_ type: String) -> [[String: Any]] { lock.withLock { invoked.filter { $0["type"] as? String == type } } }
    @MainActor func waitFor(_ type: String) async throws -> [String: Any] {
        try await until("a \(type) action") { !actions(type).isEmpty }
        return actions(type)[0]
    }
}

/// Outside apps' sign-ins (ADR 0122): the push payload, the words, the local alert while ace is in
/// the background, and a tap that opens the sign-in sheet on its machine or says it ended.
@Suite @MainActor struct AccessAlertTests {
    @Test func aSignInPushDecodesAndAThreadAlertsPayloadIsNotMistakenForOne() throws {
        let access = #"{"v":1,"hostId":"studio","access":{"requestId":"r1","clientName":"Claude","domain":"claude.ai","matchCode":"7KQ2XM","expiresAt":1800000000000}}"#
        let decoded = try #require(AccessAlert.push(Data(access.utf8)))
        #expect(decoded.hostId == "studio")
        #expect(decoded.alert == AccessAlert(requestId: "r1", clientName: "Claude", domain: "claude.ai", matchCode: "7KQ2XM", expiresAt: 1_800_000_000_000))
        let unverified = #"{"v":1,"hostId":"studio","access":{"requestId":"r1","clientName":"Bot","domain":null,"matchCode":"7KQ2XM","expiresAt":1}}"#
        #expect(AccessAlert.push(Data(unverified.utf8))?.alert.domain == nil)
        // The older, thread-shaped payload is a thread alert's business, never a sign-in.
        let thread = #"{"v":1,"hostId":"studio","notification":{"id":"n:1","threadId":"t","title":"Fix","status":"needs_you","backgroundCount":0,"actions":[]}}"#
        #expect(AccessAlert.push(Data(thread.utf8)) == nil)
        // A later version, or one missing what it must say, is dropped: the generic text stays.
        #expect(AccessAlert.push(Data(access.replacingOccurrences(of: #""v":1"#, with: #""v":2"#).utf8)) == nil)
        #expect(AccessAlert.push(Data(access.replacingOccurrences(of: #""matchCode":"7KQ2XM""#, with: #""matchCode":"""#).utf8)) == nil)
        #expect(AccessAlert.push(Data("not json".utf8)) == nil)
    }

    @Test func theAlertNamesWhoAsksTheMachineAndTheCodeToCompare() {
        let verified = AccessAlert(requestId: "r1", clientName: "Claude", domain: "claude.ai", matchCode: "7KQ2XM", expiresAt: 1)
        #expect(verified.words(machine: "studio") == ("Claude wants to sign in to studio", "Code 7KQ2XM · claude.ai"))
        let unverified = AccessAlert(requestId: "r1", clientName: "Bot", domain: nil, matchCode: "7KQ2XM", expiresAt: 1)
        #expect(unverified.words(machine: nil) == ("Bot wants to sign in to your computer", "Code 7KQ2XM · Unverified app"))
    }

    @Test func aSignInArrivingWhileAceIsInTheBackgroundAlertsOnceAndGoesWhenTheMachineStopsListingIt() async throws {
        let (coordinator, center, session, _) = try await connected()
        coordinator.scene(active: false)
        session.patch(state(["r1"]))
        try await until("the sign-in is alerted") { center.posted.count == 1 }
        let posted = try #require(center.posted.first)
        #expect(posted.identifier == "host|access:r1")
        #expect((posted.title, posted.body) == ("Claude wants to sign in to studio", "Code 7KQ2XM · claude.ai"))
        #expect(posted.access?.requestId == "r1")
        // The machine says it again, and says nothing once the connection drops: no second alert,
        // and a dropped connection withdraws nothing, since the request may still be waiting.
        session.patch(state(["r1"]))
        session.patch(state([], live: false))
        session.patch(state(["r1"]))
        try await Task.sleep(for: .milliseconds(30))
        #expect(center.posted.count == 1)
        #expect(center.withdrawn.isEmpty)
        // Answered, expired or cancelled: the machine stops listing it and the alert goes.
        session.patch(state([]))
        try await until("the ended sign-in is withdrawn") { center.withdrawn == ["host|access:r1"] }
    }

    @Test func aSignInArrivingWhileAceIsOpenPostsNothingBecauseTheSheetOpensItself() async throws {
        let (_, center, session, model) = try await connected()
        session.patch(state(["r1"]))
        try await until("the sheet has it") { model.outside.asking?.requestId == "r1" }
        try await Task.sleep(for: .milliseconds(30))
        #expect(center.posted.isEmpty)
    }

    @Test func tappingASignInAlertAsksItsMachineToOpenThatRequest() async throws {
        let (coordinator, _, session, _) = try await connected()
        var info = tapped.info
        info[NotificationKeys.hostId] = "host"
        await coordinator.respond(action: "com.apple.UNNotificationDefaultActionIdentifier", notificationId: "host|access:r2", info: info)
        let open = try await session.waitFor("outside.open")
        #expect(open["requestId"] as? String == "r2")
        #expect(open["clientName"] as? String == "Claude")
    }

    @Test func aTapOnAColdLaunchWaitsForTheMachineToConnect() async throws {
        let sessions = Sessions()
        let coordinator = NotificationCoordinator(center: FakeCenter(), authorizer: FakeAuthorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, connectInBackground: { _ in [] })
        var info = tapped.info
        info[NotificationKeys.hostId] = "host"
        await coordinator.respond(action: "com.apple.UNNotificationDefaultActionIdentifier", notificationId: "host|access:r2", info: info)
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(model, target: try target())
        await model.connect(target: try target(), directory: URL(fileURLWithPath: "/unused"))
        let session = try #require(sessions.values.first)
        session.patch(#"{"type":"notifications.connected"}"#)
        #expect(try await session.waitFor("outside.open")["requestId"] as? String == "r2")
    }

    @Test func theMachinesAnswerToATapOpensThatSheetFirstOrSaysItEndedOnce() async throws {
        let (_, _, session, model) = try await connected()
        session.patch(state(["r1", "r2"]))
        try await until("both sign-ins arrive") { model.outside.access.count == 2 }
        model.outside.setAside.insert("r2")
        session.patch(state(["r1", "r2"], opened: #"{"n":1,"requestId":"r2","ended":null}"#))
        try await until("the tapped sign-in shows first") { model.outside.asking?.requestId == "r2" }
        session.patch(state(["r1"], opened: #"{"n":2,"requestId":"gone","ended":"Claude's sign-in request ended. Ask it to sign in again."}"#))
        try await until("the ended sign-in is said") { model.outside.ended != nil }
        model.outside.ended = nil
        // The same answer again (a later state) isn't said twice.
        session.patch(state(["r1"], opened: #"{"n":2,"requestId":"gone","ended":"Claude's sign-in request ended. Ask it to sign in again."}"#))
        try await Task.sleep(for: .milliseconds(30))
        #expect(model.outside.ended == nil)
        #expect(model.outside.asking?.requestId == "r1")
    }

    // MARK: Support

    private let tapped = AccessAlert(requestId: "r2", clientName: "Claude", domain: "claude.ai", matchCode: "7KQ2XM", expiresAt: 1_800_000_000_000)
    private func connected() async throws -> (NotificationCoordinator, FakeCenter, Session, ClientModel) {
        let center = FakeCenter()
        let sessions = Sessions()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, connectInBackground: { _ in [] })
        coordinator.machineName = { $0 == "host" ? "studio" : nil }
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(model, target: try target())
        await model.connect(target: try target(), directory: URL(fileURLWithPath: "/unused"))
        await coordinator.setEnabled(true)
        let session = try #require(sessions.values.first)
        session.patch(#"{"type":"connection","state":"ready"}"#)
        try await until("the connection is ready") { model.connection == "ready" }
        return (coordinator, center, session, model)
    }
    private func defaults() throws -> UserDefaults { try #require(UserDefaults(suiteName: "ace.tests.\(UUID().uuidString)")) }
    private func target() throws -> ConnectionTarget {
        ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:9841")), hostId: "host", deviceId: "phone", pin: nil, credential: { "{}" })
    }
    /// The bridge's `outside.state` with these sign-ins waiting.
    private func state(_ ids: [String], live: Bool = true, opened: String = "null") -> String {
        let access = ids.map { id in
            #"{"requestId":"\#(id)","clientName":"Claude","domain":"claude.ai","verified":true,"matchCode":"7KQ2XM","expiresAt":1800000000000,"redirect":"Signs in to claude.ai","choices":[],"expiries":[],"expiry":"month"}"#
        }.joined(separator: ",")
        return #"{"type":"outside.state","access":[\#(access)],"screen":[],"opened":\#(opened),"live":\#(live)}"#
    }
}
/// How many waiting copies have returned.
@MainActor private final class Returns { var count = 0 }
