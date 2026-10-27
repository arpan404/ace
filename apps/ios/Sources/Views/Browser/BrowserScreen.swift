import SwiftUI

/// The sheets the browser screen opens from its bar and menu.
enum BrowserSheet: String, Identifiable {
    case tabs, console, history, downloads, settings, source, sizes, extensions
    var id: String { rawValue }
}

/// The thread's browser, pushed from the thread: the live page fills the screen and takes touches
/// and typing; a glass bar at the bottom holds Back, Forward, the address, the tabs and the menu,
/// as Safari's does. Who has the page is said in one sentence above the bar, with Take over or
/// Hand back. The page's own prompts (dialogs, sign-ins, file pickers) come up as native alerts.
struct BrowserScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Bindable var model: ClientModel
    /// The thread's open browser request, if the agent asked the person for help.
    let help: ApprovalRow?
    /// Back to the thread's message; with a page, it goes into the message ("Ask agent about this page").
    var toMessage: (BrowserViewInfo.Mention?) -> Void = { _ in }
    let answerHelp: ([String: Any]) -> Void
    @State private var keyboardRequest = 0
    @State private var answeredPicker: String?
    @State private var editingAddress = false
    @State private var finding = false
    @State private var sheet: BrowserSheet?
    @State private var clearing = false
    @AppStorage("ace.browser.extensionsInBar") private var extensionsInBar = false

    private var browser: BrowserLiveModel { model.browser }
    private var state: BrowserViewInfo.State? { browser.view?.state }
    private var shownTab: BrowserViewInfo.Tab? { state?.tabs.first { $0.id == state?.activeTabId } }
    private var annotate: BrowserViewInfo.Annotate? { state?.annotate }
    private var annotating: Bool { annotate.map { $0.mode != "off" } ?? false }
    private var title: String {
        guard let state, state.blank != true, !state.closed else { return "Browser" }
        return shownTab?.title ?? "Browser"
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            // The page keeps its size while a keyboard shows; the find and address fields ride it.
            VStack(spacing: AceTheme.Spacing.none) {
                page
                if !finding {
                    strips
                    BrowserBar(model: model, editing: $editingAddress, sheet: $sheet, finding: $finding, clearing: $clearing,
                               screenshot: { model.browserScreenshot(fullPage: $0) })
                }
            }
            .ignoresSafeArea(.keyboard)
            if finding {
                BrowserFindBar(model: model) { finding = false }
                    .background(AceTheme.Colours.background)
            }
            if editingAddress {
                BrowserAddressEditor(model: model, editing: $editingAddress)
                    .transition(.opacity)
            }
        }
        .overlay(alignment: .top) { BrowserDoneNote(model: model) }
        .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: editingAddress)
        .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: annotating)
        .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: state?.recording)
        .background(AceTheme.Colours.background)
        .threadTitle(title, subtitle: shownTab?.host ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.canOperate, browser.page?.focus != nil || annotate?.mode == "on", !editingAddress {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Keyboard", ace: .keyboard) { keyboardRequest += 1 }
                        .accessibilityIdentifier("browser.keyboard")
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) { pageActions }
        }
        .confirmationDialog("Clear browsing data?", isPresented: $clearing, titleVisibility: .visible) {
            Button("Clear browsing data", role: .destructive) { model.browserClearData() }
        } message: {
            Text("Cookies, the cache and site storage of this browser go. Sites sign you out.")
        }
        .sensoryFeedback(.selection, trigger: annotating)
        .onChange(of: browser.annotateSends) { toMessage(nil) }
        .browserPrompts(model: model)
        .sheet(item: $sheet) { which in BrowserSheets(model: model, sheet: which) }
        .sheet(item: Binding(get: { openPicker }, set: { _ in })) { picker in
            BrowserPickerSheet(picker: picker) { values in
                answeredPicker = picker.pickerId
                model.browserInput([.pick(pickerId: picker.pickerId, values: values)])
            }
            .onDisappear {
                // Swiped away: the page's picker closes unchanged, unless the page already did.
                guard answeredPicker != picker.pickerId, browser.page?.picker?.pickerId == picker.pickerId else { return }
                answeredPicker = picker.pickerId
                model.browserInput([.pick(pickerId: picker.pickerId, values: nil)])
            }
        }
        .sheet(item: Binding(get: { browser.shot }, set: { browser.shot = $0 })) { shot in
            BrowserShotSheet(shot: shot)
        }
        .alert("Browser", isPresented: Binding(get: { browser.problem != nil }, set: { if !$0 { browser.problem = nil } })) {
            Button("OK") { browser.problem = nil }
        } message: { Text(browser.problem?.message ?? "") }
        .onChange(of: scenePhase, initial: true) { _, phase in browser.setVisible(phase == .active) }
        .onDisappear { model.closeBrowser() }
    }

    /// The page's two actions that matter most, always in reach: ask the agent about the page,
    /// and annotate it. The engine's extensions join them when the person pins them here.
    @ViewBuilder private var pageActions: some View {
        if extensionsInBar, state?.closed == false {
            Button("Extensions", ace: .puzzlePiece) { sheet = .extensions }
                .accessibilityIdentifier("browser.extensions")
        }
        if model.canOperate, let mention = state?.shown?.mention {
            Button("Ask agent about this page", ace: .chatCircleText) {
                toMessage(mention)
            }
            .accessibilityIdentifier("browser.ask")
        }
        if model.canOperate, let annotate {
            Button(annotating ? "Stop annotating" : "Annotate", ace: .pencilSimpleLine) {
                model.browserAnnotate(!annotating, dark: colorScheme == .dark)
            }
            .disabled(!annotating && annotate.unavailable != nil)
            .accessibilityValue(annotating ? "On" : "Off")
            .accessibilityHint(annotate.unavailable ?? "")
            .accessibilityIdentifier("browser.annotate")
        }
    }

    private var openPicker: BrowserPageInfo.Picker? {
        guard model.canOperate, let picker = browser.page?.picker, picker.pickerId != answeredPicker else { return nil }
        return picker
    }

    /// The live page, with whatever stands in front of it.
    private var page: some View {
        GeometryReader { proxy in
            ZStack {
                BrowserSurface(model: model, keyboardRequest: keyboardRequest, annotating: annotate?.mode == "on")
                if let geometry = browser.geometry(view: proxy.size) {
                    if let tooltip = browser.page?.tooltip {
                        let box = geometry.viewRect(PageRect(x: tooltip.x, y: tooltip.y, width: 0, height: 0))
                        Text(tooltip.text)
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .padding(AceTheme.Spacing.xs)
                            .background(.regularMaterial, in: AceShape.capsule)
                            .fixedSize()
                            .position(x: min(max(box.minX, 80), proxy.size.width - 80), y: box.minY + 24)
                            .allowsHitTesting(false)
                    }
                    if let pointer = state?.shown?.pointer {
                        AgentCursor(name: state?.shown?.agent ?? "An agent",
                                    at: geometry.viewRect(PageRect(x: pointer.x, y: pointer.y, width: 0, height: 0)).origin)
                    }
                }
                BrowserPageState(model: model, openAddress: { editingAddress = true })
            }
        }
        .clipped()
    }

    /// One sentence each, above the bar: the agent's request for help, who has the page, and a
    /// site permission the browser blocked.
    @ViewBuilder private var strips: some View {
        if let help, help.state == "pending" {
            BrowserStrip(sentence: help.help?.title ?? "The agent needs you on this page") {
                Button("Skip") { answerHelp(["kind": "help", "outcome": "skipped"]) }
                    .accessibilityIdentifier("browser.help.skip")
                Button("Done") {
                    answerHelp(["kind": "help", "outcome": "done"])
                    dismiss()
                }
                .fontWeight(.semibold)
                .accessibilityIdentifier("browser.help.done")
            }
            .disabled(model.approvalSubmissions[help.id] != nil || !model.canOperate)
        }
        if let shown = state?.shown, let tabId = state?.activeTabId {
            if shown.private {
                BrowserStrip(sentence: "Agents are kept out of this page") {
                    if model.canOperate {
                        Button("Hand back") { model.browserTakeOver(tabId, false) }.accessibilityIdentifier("browser.handBack")
                    }
                }
            } else if let agent = shown.agent {
                BrowserStrip(sentence: "\(agent) is using this page") {
                    if model.canOperate {
                        Button("Take over") { model.browserTakeOver(tabId, true) }.accessibilityIdentifier("browser.takeOver")
                    }
                }
            }
        }
        if let annotate, annotate.mode != "off" {
            BrowserStrip(sentence: annotationSentence) {
                Button("Done") { model.browserAnnotate(false, dark: colorScheme == .dark) }
                    .accessibilityIdentifier("browser.annotate.done")
                Button("Write message") {
                    model.browserAnnotate(false, dark: colorScheme == .dark)
                    toMessage(nil)
                }
                .fontWeight(.semibold)
                .accessibilityIdentifier("browser.annotate.message")
            }
            .transition(.opacity)
        }
        if let recording = state?.recording {
            BrowserStrip(sentence: recording.byPerson ? "Recording this page" : "An agent is recording this page") {
                if model.canOperate, recording.byPerson {
                    Button("Stop") { model.browserRecord(false) }.accessibilityIdentifier("browser.record.stop")
                }
            }
            .transition(.opacity)
        }
        if let permission = state?.permission {
            BrowserStrip(sentence: permission) { EmptyView() }
        }
        if let device = browser.view?.device, device.toolbar, state?.activeTabId != nil, state?.closed == false {
            BrowserDeviceBar(model: model, device: device)
        }
    }
}

extension BrowserScreen {
    /// The annotate strip's one sentence: how many comments are pinned, or that it starts.
    fileprivate var annotationSentence: String {
        if annotate?.mode == "starting" { return "Starting to annotate…" }
        let count = model.thread?.screen.annotations.count ?? 0
        return count == 0 ? "Annotating this page" : count == 1 ? "1 annotation on the message" : "\(count) annotations on the message"
    }
}

/// One plain sentence and its text buttons, over a hairline.
struct BrowserStrip<Actions: View>: View {
    let sentence: String
    @ViewBuilder var actions: () -> Actions
    var body: some View {
        HStack(spacing: AceTheme.Spacing.lg) {
            Text(sentence)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            actions()
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
        .tint(AceTheme.Colours.foreground)
        .padding(.horizontal, AceTheme.Spacing.xl)
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .overlay(alignment: .top) {
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("browser.strip")
    }
}

/// Where the agent last pointed: a cursor that glides there and never takes a touch.
private struct AgentCursor: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let name: String
    let at: CGPoint
    var body: some View {
        AceIcon(.cursor, size: 22, relativeTo: .title3)
            .foregroundStyle(AceTheme.Colours.foreground)
            .shadow(color: AceTheme.Colours.background, radius: 1)
            .offset(x: 7, y: 9)
            .position(at)
            .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: at)
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(name) is pointing here")
    }
}

extension BrowserPageInfo.Picker: Identifiable { var id: String { pickerId } }
extension BrowserShot: Identifiable { var id: Double { at } }
