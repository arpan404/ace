import Markit
import SwiftUI
import UIKit

/// How agents' answers are read, as the web reads them: markit's agent flavour (GitHub's
/// Markdown without forge references, inline and display maths typeset natively) with Mermaid
/// fences drawn as diagrams. A diagram is drawn once by the forge pages' renderer
/// (`MermaidDiagram`), off screen, and kept as a picture (`DiagramRenders`): rows that scroll by
/// hold no web view, and one scrolled back shows the kept picture. Until it is drawn, and when it
/// can't be, markit shows the fence's code.
@MainActor enum AnswerMarkdown {
    static let flavor: MarkitFlavor = .agent

    /// One set for the app: a diagram's picture depends only on its text and the appearance.
    static let diagrams = DiagramRenders<DiagramPicture> { source, dark in
        await MermaidDiagram.picture(source, dark: dark)
    }

    /// markit's `renderDiagram` for answers: the diagram once drawn, nil to keep its code.
    static func renderDiagram(dark: Bool) -> @MainActor (_ language: String, _ source: String) async -> UIView? {
        { language, source in
            guard DiagramFence.draws(language), let picture = await diagrams.drawn(source, dark: dark) else { return nil }
            return AnswerDiagramView(source: source, picture: picture, dark: dark)
        }
    }
}

/// A drawn diagram in an answer: its picture at the size it drew (markit scales it to a narrower
/// column), with its source a tap away (the corner button, the long-press menu, VoiceOver's
/// actions). It follows the app between light and dark, drawing the other appearance once.
final class AnswerDiagramView: UIView, UIContextMenuInteractionDelegate {
    let source: String
    private let size: CGSize
    private var dark: Bool
    private let picture = UIImageView()
    private let sourceButton = UIButton(type: .system)
    private var restyle: Task<Void, Never>?

    init(source: String, picture drawn: DiagramPicture, dark: Bool) {
        self.source = source
        size = drawn.size
        self.dark = dark
        super.init(frame: CGRect(origin: .zero, size: drawn.size))
        picture.image = drawn.image
        picture.contentMode = .scaleAspectFit
        picture.isAccessibilityElement = true
        picture.accessibilityLabel = "Diagram"
        picture.accessibilityTraits = .image
        picture.accessibilityIdentifier = "answer.diagram"
        picture.accessibilityCustomActions = [
            UIAccessibilityCustomAction(name: "Show source") { [weak self] _ in self?.showSource(); return true },
            UIAccessibilityCustomAction(name: "Copy source") { [weak self] _ in self?.copySource(); return true },
        ]
        addSubview(picture)

        var look = UIButton.Configuration.plain()
        look.image = UIImage(named: "ph-code")?.withRenderingMode(.alwaysTemplate)
        look.baseForegroundColor = UIColor(AceTheme.Colours.mutedForeground)
        look.background.backgroundColor = UIColor(AceTheme.Colours.fill)
        look.cornerStyle = .capsule
        look.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 6)
        sourceButton.configuration = look
        sourceButton.accessibilityLabel = "Show diagram source"
        sourceButton.accessibilityIdentifier = "answer.diagram.source"
        sourceButton.addAction(UIAction { [weak self] _ in self?.showSource() }, for: .primaryActionTriggered)
        addSubview(sourceButton)

        addInteraction(UIContextMenuInteraction(delegate: self))
        accessibilityElements = [picture, sourceButton]
        _ = registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: AnswerDiagramView, _: UITraitCollection) in
            view.followAppearance()
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var intrinsicContentSize: CGSize { size }

    override func layoutSubviews() {
        super.layoutSubviews()
        picture.frame = bounds
        let side = Self.buttonSide, inset = Self.slack
        sourceButton.frame = CGRect(x: bounds.maxX - side - inset, y: inset, width: side, height: side)
    }

    /// Small over the diagram, inset by the slack that makes its target a finger's width.
    private static let buttonSide: CGFloat = 32
    private static var slack: CGFloat { (AceDesign.Size.tap - buttonSide) / 2 }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if !sourceButton.isHidden, sourceButton.frame.insetBy(dx: -Self.slack, dy: -Self.slack).contains(point) { return sourceButton }
        return super.hitTest(point, with: event)
    }

    private func followAppearance() {
        let now = traitCollection.userInterfaceStyle == .dark
        guard now != dark else { return }
        dark = now
        restyle?.cancel()
        if let kept = AnswerMarkdown.diagrams.kept(source, dark: now) {
            picture.image = kept.image
            return
        }
        restyle = Task { [weak self, source] in
            guard let drawn = await AnswerMarkdown.diagrams.drawn(source, dark: now), let self, self.dark == now else { return }
            self.picture.image = drawn.image
        }
    }

    private func copySource() { UIPasteboard.general.string = source }

    private func showSource() {
        let sheet = UIHostingController(rootView: DiagramSourceSheet(source: source, close: {}))
        sheet.rootView = DiagramSourceSheet(source: source, close: { [weak sheet] in sheet?.dismiss(animated: true) })
        if let presentation = sheet.sheetPresentationController {
            presentation.detents = [.medium(), .large()]
            presentation.prefersGrabberVisible = true
        }
        presenter()?.present(sheet, animated: true)
    }

    /// The controller showing this view, or what it already presents on top.
    private func presenter() -> UIViewController? {
        var controller = sequence(first: self as UIResponder, next: { $0.next }).lazy.compactMap { $0 as? UIViewController }.first
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            UIMenu(children: [
                UIAction(title: "Show source", image: UIImage(named: "ph-code")) { _ in self?.showSource() },
                UIAction(title: "Copy source", image: UIImage(named: "ph-copy")) { _ in self?.copySource() },
            ])
        }
    }
}

/// A diagram's Mermaid source, selectable, with Copy.
struct DiagramSourceSheet: View {
    let source: String
    let close: () -> Void
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                Text(verbatim: source)
                    .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(AceDesign.Space.margin)
                    .accessibilityIdentifier("diagram.source")
            }
            .background(AceTheme.Colours.background)
            .navigationTitle("Diagram source")
            .navigationBarTitleDisplayMode(.inline)
            .escapeCloses(close)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: close) { AceIcon(.x) }.accessibilityLabel("Close")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(copied ? "Copied" : "Copy") {
                        UIPasteboard.general.string = source
                        copied = true
                    }
                    .accessibilityIdentifier("diagram.copy")
                }
            }
            .sensoryFeedback(.success, trigger: copied) { _, now in now }
        }
    }
}
