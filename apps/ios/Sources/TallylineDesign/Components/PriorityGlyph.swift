#if os(iOS)
import SwiftUI
import TallylineCore

/// Three ascending bars; the filled count is the priority. Urgent and high
/// use status colours, the rest stay quiet. No priority draws all three faint.
public struct PriorityGlyph: View {
    public let priority: IssuePriority
    @ScaledMetric(relativeTo: .caption) private var height: CGFloat = 12

    public init(priority: IssuePriority) { self.priority = priority }

    public var body: some View {
        PriorityBars(filled: priority.barCount, fill: Self.tint(for: priority))
            .frame(width: height, height: height)
            .motion(.quick, value: priority)
            .accessibilityHidden(true)
    }

    public static func tint(for priority: IssuePriority) -> Color {
        switch priority {
        case .urgent: Theme.urgent
        case .high: Theme.attention
        case .medium, .low: Theme.inkMuted
        case .none: Theme.inkSubtle
        }
    }
}

private struct PriorityBars: View {
    let filled: Int
    let fill: Color

    var body: some View {
        Canvas { context, size in
            let gap = size.width * 0.12
            let barWidth = (size.width - gap * 2) / 3
            for index in 0..<3 {
                let heightFraction = 0.4 + 0.3 * CGFloat(index)
                let barHeight = size.height * heightFraction
                let rect = CGRect(x: CGFloat(index) * (barWidth + gap), y: size.height - barHeight, width: barWidth, height: barHeight)
                let path = Path(roundedRect: rect, cornerRadius: barWidth * 0.3)
                context.fill(path, with: .color(index < filled ? fill : Theme.liningStrong))
            }
        }
    }
}

#Preview("Priority glyphs") {
    HStack(spacing: 14) {
        ForEach(IssuePriority.allCases, id: \.self) { PriorityGlyph(priority: $0) }
    }
    .padding()
    .background(Theme.canvas)
}

#Preview("Priority glyphs, dark") {
    HStack(spacing: 14) {
        ForEach(IssuePriority.allCases, id: \.self) { PriorityGlyph(priority: $0) }
    }
    .padding()
    .background(Theme.canvas)
    .preferredColorScheme(.dark)
}
#endif
