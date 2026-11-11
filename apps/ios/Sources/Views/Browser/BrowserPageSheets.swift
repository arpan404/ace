import SwiftUI
import UIKit

/// A finished page command, said once at the top of the page on glass ("PDF saved to this
/// thread"), gone after a few seconds or a tap.
struct BrowserDoneNote: View {
    @Bindable var model: ClientModel
    var body: some View {
        ZStack {
            if let done = model.browser.done {
                Button { model.browser.done = nil } label: {
                    VStack(spacing: AceTheme.Spacing.xxs) {
                        Text(done.message).font(AceDesign.Typeface.body)
                            .foregroundStyle(AceDesign.Ink.primary)
                        if let detail = done.detail {
                            Text(detail).font(AceDesign.Typeface.meta)
                                .foregroundStyle(AceDesign.Ink.muted).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    .padding(.horizontal, AceDesign.Space.margin).padding(.vertical, AceDesign.Space.related)
                    .frame(minHeight: AceDesign.Size.tap)
                    .aceGlass(in: AceDesign.Shape.control)
                }
                .buttonStyle(.plain)
                .padding(.top, AceDesign.Space.related)
                .transition(.opacity)
                .accessibilityIdentifier("browser.done")
                .task(id: done.at) {
                    try? await Task.sleep(for: .seconds(3))
                    if model.browser.done?.at == done.at { model.browser.done = nil }
                }
            }
        }
        .animation(.default, value: model.browser.done)
        .sensoryFeedback(.success, trigger: model.browser.done?.at) { _, new in new != nil }
    }
}

/// The shown page's source as the server sent it, readable on a phone: wrapped, monospaced,
/// selectable, to copy or share. Long sources are shortened and say so.
struct BrowserSourceSheet: View {
    @Bindable var model: ClientModel
    @State private var wrap = true
    var body: some View {
        NavigationStack {
            Group {
                if let problem = model.browser.problem {
                    VStack {
                        Text(problem.message).foregroundStyle(AceTheme.StatusText.failed)
                        Button("Retry") { model.browser.problem = nil; model.browserSource(open: true) }.buttonStyle(.textAction())
                    }
                } else if let source = model.browser.source {
                    SourceText(text: source.source, wrap: wrap)
                        .ignoresSafeArea(edges: .bottom)
                        .safeAreaInset(edge: .bottom) {
                            if source.truncated {
                                Text("Shortened: the page's source is longer.")
                                    .font(AceDesign.Typeface.meta)
                                    .foregroundStyle(AceDesign.Ink.muted)
                                    .frame(maxWidth: .infinity).padding(AceDesign.Space.related)
                                    .background(AceDesign.Surface.background)
                            }
                        }
                        .transition(.opacity)
                } else {
                    SkeletonLines().transition(.opacity)
                }
            }
            .animation(.default, value: model.browser.source == nil)
            .background(AceDesign.Surface.background)
            .navigationTitle("Page source").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose()
                if let source = model.browser.source {
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button(wrap ? "Don't wrap lines" : "Wrap lines", ace: .textAlignLeft) { wrap.toggle() }
                        Button("Copy", ace: .copy) { UIPasteboard.general.string = source.source }
                        ShareLink(item: source.source, subject: Text(source.url))
                    }
                }
            }
        }
        .tint(AceDesign.Ink.accent)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
        .onAppear { model.browser.problem = nil; model.browserSource(open: true) }
        .onDisappear { model.browserSource(open: false) }
    }
}

/// A large read-only text, drawn by TextKit so a long source scrolls without laying it all out
/// in SwiftUI.
private struct SourceText: UIViewRepresentable {
    let text: String
    let wrap: Bool
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(for: .monospacedSystemFont(ofSize: AceDesign.TextRole.meta.size, weight: .regular))
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor(AceDesign.Ink.primary)
        view.textContainerInset = UIEdgeInsets(top: AceDesign.Space.related, left: AceDesign.Space.margin, bottom: AceDesign.Space.group, right: AceDesign.Space.margin)
        view.accessibilityIdentifier = "browser.source.text"
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
        view.textContainer.widthTracksTextView = wrap
        view.textContainer.size.width = wrap ? view.bounds.width : 100_000
        view.textContainer.lineBreakMode = wrap ? .byCharWrapping : .byClipping
        view.setNeedsLayout()
    }
}

/// Grey lines where text arrives, at the size the text will be.
private struct SkeletonLines: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            ForEach(0..<8, id: \.self) { index in
                // Ragged widths, like lines of source: content geometry.
                SkeletonBar(width: [220, 300, 180, 260, 140, 290, 200, 240][index], height: 12)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(AceDesign.Space.margin)
        .accessibilityLabel("Reading the page source")
    }
}

/// Screenshots of the shown page laid out at phone, tablet and desktop widths: choose the sizes,
/// take them, then look through and share each.
struct BrowserSizesSheet: View {
    @Bindable var model: ClientModel
    @State private var chosen: Set<String> = ["phone", "tablet", "desktop"]
    @State private var asked = false
    private static let sizes: [(id: String, title: String, width: Int)] = [("phone", "Phone", 390), ("tablet", "Tablet", 768), ("desktop", "Desktop", 1440)]
    var body: some View {
        NavigationStack {
            Group {
                if asked, let images = model.browser.sizes?.images, !images.isEmpty {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: AceDesign.Space.group) {
                            ForEach(images) { SizedShot(image: $0) }
                        }
                        .padding(AceDesign.Space.margin)
                    }
                    .transition(.opacity)
                } else if asked, model.browser.sizes?.images == nil {
                    VStack(spacing: AceDesign.Space.row) {
                        WorkingMark()
                        Text("Laying the page out at each size").font(AceDesign.Typeface.title)
                            .foregroundStyle(AceDesign.Ink.muted)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity)
                } else {
                    ScrollView {
                        QuietSection("Sizes") {
                            ForEach(Self.sizes, id: \.id) { size in
                                Button { toggle(size.id) } label: {
                                    QuietSectionRow {
                                        QuietRowText(title: size.title, detail: "\(size.width) px wide")
                                        if chosen.contains(size.id) { AceIcon(.check).foregroundStyle(AceDesign.Ink.primary) }
                                    }
                                }
                                .buttonStyle(.plain)
                                .accessibilityAddTraits(chosen.contains(size.id) ? .isSelected : [])
                                .accessibilityIdentifier("browser.sizes.\(size.id)")
                            }
                        }.padding(.vertical, AceDesign.Space.related)
                    }
                    .transition(.opacity)
                }
            }
            .animation(.default, value: asked)
            .animation(.default, value: model.browser.sizes)
            .background(AceDesign.Surface.background)
            .navigationTitle("Screenshots").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose()
                if !asked || model.browser.sizes?.images?.isEmpty == true {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Take") {
                            asked = true
                            model.browserSizes(Self.sizes.map(\.id).filter { chosen.contains($0) })
                        }
                        .disabled(chosen.isEmpty)
                        .accessibilityIdentifier("browser.sizes.take")
                    }
                }
            }
        }
        .tint(AceDesign.Ink.accent)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        .sensoryFeedback(.selection, trigger: chosen)
        .onAppear { model.browser.sizes = nil }
    }
    private func toggle(_ id: String) {
        if chosen.contains(id) { chosen.remove(id) } else { chosen.insert(id) }
    }
}

/// One size's screenshot, decoded off the main thread, with its size and Share.
private struct SizedShot: View {
    let image: BrowserSizes.Image
    @State private var picture: UIImage?
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            HStack {
                Text(image.size.capitalized).font(AceDesign.Typeface.body)
                Text("\(image.width) × \(image.height)").font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted).monospacedDigit()
                Spacer()
                if let picture {
                    let shown = Image(uiImage: picture)
                    ShareLink(item: shown, preview: SharePreview("\(image.size.capitalized) screenshot", image: shown)) {
                        Text("Share")
                    }
                    .frame(minHeight: AceDesign.Size.tap)
                }
            }
            ZStack {
                AceDesign.Shape.block.fill(AceDesign.Surface.fill)
                if let picture {
                    Image(uiImage: picture).resizable().scaledToFit()
                        .clipShape(AceDesign.Shape.block)
                        .transition(.opacity)
                }
            }
            .aspectRatio(CGFloat(max(image.width, 1)) / CGFloat(max(image.height, 1)), contentMode: .fit)
            .frame(maxWidth: .infinity)
            .animation(.default, value: picture != nil)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("browser.sizes.shot.\(image.size)")
        .task(id: image.data.count) {
            let data = image.data
            picture = await Task.detached(priority: .userInitiated) {
                Data(base64Encoded: data).flatMap(UIImage.init(data:))?.preparingForDisplay()
            }.value
        }
    }
}

/// The extensions the browser runs, as its engine reports them, never a made-up list. ace's own
/// browser loads none; Use my Chrome lets agents work in the person's Chrome with its extensions.
/// The puzzle button can sit in the browser's top bar.
struct BrowserExtensionsSheet: View {
    @Bindable var model: ClientModel
    @AppStorage("ace.browser.extensionsInBar") private var inBar = false
    private var items: [BrowserExtensions.Item]? { model.browser.extensions?.items }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    if let problem = model.browser.problem {
                        QuietSectionRow {
                            VStack(alignment: .leading) {
                                Text(problem.message).foregroundStyle(AceTheme.StatusText.failed)
                                Button("Retry") { model.browser.problem = nil; model.browserExtensions() }.buttonStyle(.textAction())
                            }
                        }
                    }
                    QuietSection("Extensions") {
                        if let items {
                            if items.isEmpty { QuietSectionRow { QuietRowText(title: "No extensions installed", tone: AceDesign.Ink.muted) } }
                            ForEach(items) { item in
                                QuietSectionRow {
                                    QuietRowText(title: item.name, detail: [item.version, item.enabled ? nil : "Off"].compactMap { $0 }.joined(separator: " · "))
                                }
                            }
                        } else if model.browser.problem == nil {
                            SkeletonRows(count: 2, label: "Reading extensions")
                        }
                    }
                    QuietSection {
                        QuietSectionRow {
                            Toggle("Show in the browser bar", isOn: $inBar)
                                .accessibilityIdentifier("browser.extensions.inBar")
                        }
                        if model.browser.view?.state?.ownChrome != true {
                            NavigationLink { UseMyChromeView(model: model) } label: {
                                QuietSectionRow { QuietRowText(title: "Use your Chrome's extensions"); RowCaret() }
                            }
                            .buttonStyle(.plain).accessibilityIdentifier("browser.extensions.useMyChrome")
                        }
                    }
                }.padding(.vertical, AceDesign.Space.related)
            }
            .background(AceDesign.Surface.background)
            .animation(.default, value: items)
            .navigationTitle("Extensions").navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose() }
        }
        .tint(AceDesign.Ink.accent)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        .sensoryFeedback(.selection, trigger: inBar)
        .onAppear { model.browser.problem = nil; model.browserExtensions() }
        .onDisappear { model.browser.clearExtensions() }
    }
}
