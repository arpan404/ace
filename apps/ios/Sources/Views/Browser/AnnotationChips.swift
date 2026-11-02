import SwiftUI

/// The browser annotations on the next message, in one row above the words: each marker's
/// number with its comment, as the page's markers show them. Tap one for Show on page or
/// Remove; Clear takes them all off. They go with the message, after the person's words.
struct AnnotationChips: View {
    let items: [AnnotationChip]
    let remove: (String) -> Void
    let clear: () -> Void
    @Environment(\.openBrowser) private var openBrowser
    @Environment(\.aceReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: AceDesign.Space.tight) {
                    ForEach(items) { item in
                        Menu {
                            if let openBrowser {
                                Button("Show on page", ace: .browsers) { openBrowser() }
                            }
                            Button("Remove", ace: .x, role: .destructive) { remove(item.id) }
                        } label: { chip(item) }
                        .accessibilityIdentifier("composer.annotation.\(item.number)")
                        .transition(.opacity)
                    }
                }
                .animation(AceDesign.Motion.arriving(reduceMotion), value: items)
            }
            if items.count > 1 {
                Button("Clear", action: clear)
                    .font(AceDesign.Typeface.body)
                    .tint(AceDesign.Ink.muted)
                    .frame(minHeight: AceDesign.Size.tap)
                    .accessibilityIdentifier("composer.annotations.clear")
            }
        }
        .sensoryFeedback(.selection, trigger: items.count)
    }

    /// The chip's number mark (a count in a filled circle) and the most of its comment it shows.
    private static let numberDigits: CGFloat = 11
    private static let numberMark: CGFloat = 18
    private static let commentWidth: CGFloat = 180

    private func chip(_ item: AnnotationChip) -> some View {
        HStack(spacing: AceDesign.Space.tight) {
            Text("\(item.number)")
                .font(.system(size: Self.numberDigits, weight: AceDesign.Typeface.strong, design: .rounded)).monospacedDigit()
                .foregroundStyle(AceDesign.Surface.background)
                .frame(width: Self.numberMark, height: Self.numberMark)
                .background(AceDesign.Ink.primary, in: Circle())
            Text(item.comment.isEmpty ? item.label : item.comment)
                .font(AceDesign.Typeface.meta)
                .foregroundStyle(AceDesign.Ink.primary)
                .lineLimit(1)
                .frame(maxWidth: Self.commentWidth, alignment: .leading)
            if item.state == "uploading" {
                WorkingMark(label: "Uploading")
            } else if item.state == "failed" {
                Text("No image").font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceTheme.StatusText.failed)
            }
        }
        .padding(.leading, AceDesign.Space.tight).padding(.trailing, AceDesign.Space.related)
        .frame(minHeight: AceDesign.Size.slimControl)
        .background(AceDesign.Surface.fill, in: AceDesign.Shape.control)
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Annotation \(item.number): \(item.comment.isEmpty ? item.label : item.comment)")
    }
}
