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
    @Environment(\.aceReduceMotion) private var reduceMotion
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
    /// iPad: the tab shown beside the live one, as its last picture.
    @State private var splitTab: String?
    @Environment(\.horizontalSizeClass) private var sizeClass
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
                               split: sizeClass == .regular ? $splitTab : nil,
                               screenshot: { model.browserScreenshot(fullPage: $0) })
                }
            }
            .ignoresSafeArea(.keyboard)
            if finding {
                BrowserFindBar(model: model) { finding = false }
                    .background(AceDesign.Surface.background)
            }
            if editingAddress {
                BrowserAddressEditor(model: model, editing: $editingAddress)
                    .transition(.opacity)
            }
        }
        .overlay(alignment: .top) { BrowserDoneNote(model: model) }
        .animation(AceDesign.Motion.arriving(reduceMotion), value: editingAddress)
        .animation(AceDesign.Motion.arriving(reduceMotion), value: annotating)
        .animation(AceDesign.Motion.arriving(reduceMotion), value: splitTab)
        .animation(AceDesign.Motion.arriving(reduceMotion), value: state?.recording)
        .background(AceDesign.Surface.background)
        .modifier(PageTitle(title: title, subtitle: shownTab?.host ?? ""))
        .navigationBarTitleDisplayMode(.inline)
        .screenBar {
            if model.canOperate, browser.page?.focus != nil || annotate?.mode == "on", !editingAddress {
                Button("Keyboard", ace: .keyboard) { keyboardRequest += 1 }
                    .accessibilityIdentifier("browser.keyboard")
            }
            pageActions
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
        .onChange(of: state?.tabs.map(\.id)) { _, ids in if let splitTab, !(ids ?? []).contains(splitTab) { self.splitTab = nil } }
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
    }

    private var openPicker: BrowserPageInfo.Picker? {
        guard model.canOperate, let picker = browser.page?.picker, picker.pickerId != answeredPicker else { return nil }
        return picker
    }

    /// The live page, and on an iPad's split the other tab's last picture beside it. The live
    /// page keeps one place in the layout either way, so opening or closing the split never
    /// rebuilds it (its stream carries on).
    private var page: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            livePage
            if let other = splitOther {
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Dimensions.border)
                    .transition(.opacity)
                BrowserSplitPane(tab: other, still: browser.stills[other.id]) {
                    // The other half becomes the live page; this one keeps its picture.
                    self.splitTab = state?.activeTabId
                    model.browserSelectTab(other.id)
                }
                .transition(.opacity)
            }
        }
    }
    /// The tab beside the live one on an iPad's split, while it is still open and not the one shown.
    private var splitOther: BrowserViewInfo.Tab? {
        guard sizeClass == .regular, let splitTab, splitTab != state?.activeTabId else { return nil }
        return state?.tabs.first { $0.id == splitTab }
    }

    /// The live page, with whatever stands in front of it.
    private var livePage: some View {
        GeometryReader { proxy in
            ZStack {
                BrowserSurface(model: model, keyboardRequest: keyboardRequest, annotating: annotate?.mode == "on")
                if let geometry = browser.geometry(view: proxy.size) {
                    if let tooltip = browser.page?.tooltip {
                        let box = geometry.viewRect(PageRect(x: tooltip.x, y: tooltip.y, width: 0, height: 0))
                        Text(tooltip.text)
                            .font(AceDesign.Typeface.meta)
                            .padding(AceDesign.Space.tight)
                            .background(.regularMaterial, in: AceDesign.Shape.control)
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
            .overlay(alignment: .bottomTrailing) {
                if model.canOperate, let annotate, state?.closed == false {
                    DrawButton(on: annotating, unavailable: annotate.unavailable) {
                        model.browserAnnotate(!annotating, dark: colorScheme == .dark)
                    }
                    .padding(AceDesign.Space.margin)
                }
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
        if annotate?.mode == "starting" { return "Getting the page ready to draw on…" }
        let count = model.thread?.screen.annotations.count ?? 0
        return count == 0 ? "Circle or underline what to change" : "Draw another, or write your message"
    }
}

/// The round glass pen over the live page: drawing on or off. On, it fills with the accent, the
/// colour the drawings are made in.
struct DrawButton: View {
    let on: Bool
    let unavailable: String?
    let toggle: () -> Void
    var body: some View {
        Button(action: toggle) {
            AceIcon(.pencilSimpleLine, size: AceDesign.Size.barIcon, relativeTo: .title3)
                .foregroundStyle(on ? AceDesign.Ink.onAccent : AceDesign.Ink.primary)
                .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                .background { if on { Circle().fill(AceTheme.Colours.accent) } }
                .modifier(GlassUnlessOn(on: on))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!on && unavailable != nil)
        .sensoryFeedback(.selection, trigger: on)
        .accessibilityLabel(on ? "Stop drawing" : "Draw on the page")
        .accessibilityValue(on ? "On" : "Off")
        .accessibilityHint(unavailable ?? "Circle or underline what to change; the drawing goes with your message")
        .accessibilityIdentifier("browser.annotate")
    }
}

/// Glass while the pen is off; the accent's own fill while it is on (never glass under a fill).
private struct GlassUnlessOn: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if on { content } else { content.aceGlass(in: Circle(), interactive: true) }
    }
}

/// The other half of an iPad's split: the tab's title over its last picture. Tap to show it live.
struct BrowserSplitPane: View {
    let tab: BrowserViewInfo.Tab
    let still: UIImage?
    let show: () -> Void
    var body: some View {
        Button(action: show) {
            VStack(spacing: AceTheme.Spacing.none) {
                HStack {
                    Text(tab.title).font(AceDesign.Typeface.body)
                        .foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
                    Spacer(minLength: AceDesign.Space.related)
                    Text(tab.host ?? "").font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
                }
                .padding(.horizontal, AceDesign.Space.row)
                .frame(minHeight: AceDesign.Size.tap)
                ZStack(alignment: .top) {
                    AceTheme.Colours.secondaryBackground
                    if let still {
                        Image(uiImage: still).resizable().scaledToFit().transition(.opacity)
                    } else {
                        Text("Shows here once you've looked at it").font(AceDesign.Typeface.meta)
                            .foregroundStyle(AceDesign.Ink.muted).padding(.top, AceDesign.Space.group)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(tab.title), split view")
        .accessibilityHint("Shows this tab live")
        .accessibilityIdentifier("browser.split.other")
    }
}

/// One plain sentence and its text buttons, over a hairline.
struct BrowserStrip<Actions: View>: View {
    let sentence: String
    @ViewBuilder var actions: () -> Actions
    var body: some View {
        HStack(spacing: AceDesign.Space.margin) {
            Text(sentence)
                .foregroundStyle(AceDesign.Ink.muted)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            actions()
                .frame(minHeight: AceDesign.Size.tap)
                .contentShape(Rectangle())
        }
        .font(AceDesign.Typeface.body)
        .tint(AceDesign.Ink.accent)
        .padding(.horizontal, AceDesign.Space.margin)
        .frame(minHeight: AceDesign.Size.tap)
        .overlay(alignment: .top) {
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("browser.strip")
    }
}

/// Where the agent last pointed: a cursor that glides there and never takes a touch.
private struct AgentCursor: View {
    @Environment(\.aceReduceMotion) private var reduceMotion
    let name: String
    let at: CGPoint
    var body: some View {
        // The cursor is drawn on the page: its halo keeps it legible on any content, and the
        // offset puts its tip, not its centre, on the point.
        AceIcon(.cursor, size: AceDesign.Size.barIcon, relativeTo: .title3)
            .foregroundStyle(AceDesign.Ink.primary)
            .shadow(color: AceDesign.Surface.background, radius: 1)
            .offset(x: 7, y: 9)
            .position(at)
            .animation(AceDesign.Motion.arriving(reduceMotion), value: at)
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(name) is pointing here")
    }
}

extension BrowserPageInfo.Picker: Identifiable { var id: String { pickerId } }
extension BrowserShot: Identifiable { var id: Double { at } }
