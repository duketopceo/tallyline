#if os(iOS)
import SwiftUI

/// A capsule showing one property and its value. Tappable pills open the
/// property's picker. Colour is only the tint of the leading symbol; the
/// capsule itself stays on a neutral surface.
public struct PropertyPill<Leading: View>: View {
    private let title: String
    private let leading: Leading

    public init(_ title: String, @ViewBuilder leading: () -> Leading) {
        self.title = title
        self.leading = leading()
    }

    public var body: some View {
        HStack(spacing: 6) {
            leading
            Text(title)
                .font(.subheadline)
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Theme.surface2, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.lining, lineWidth: 1))
        .contentShape(Capsule())
        .hoverEffect(.highlight)
        .motion(.quick, value: title)
    }
}

public extension PropertyPill where Leading == Image {
    init(_ title: String, systemImage: String, tint: Color = Theme.inkMuted) {
        self.init(title) { Image(systemName: systemImage).foregroundStyle(tint) }
    }
}

#Preview("Pills") {
    HStack {
        PropertyPill("Urgent", systemImage: "exclamationmark.triangle.fill", tint: Theme.urgent)
        PropertyPill("Platform", systemImage: "person.2")
        PropertyPill("Cycle 4", systemImage: "arrow.triangle.2.circlepath")
    }
    .padding()
    .background(Theme.canvas)
}

#Preview("Pills, dark") {
    HStack {
        PropertyPill("Urgent", systemImage: "exclamationmark.triangle.fill", tint: Theme.urgent)
        PropertyPill("Platform", systemImage: "person.2")
    }
    .padding()
    .background(Theme.canvas)
    .preferredColorScheme(.dark)
}
#endif
