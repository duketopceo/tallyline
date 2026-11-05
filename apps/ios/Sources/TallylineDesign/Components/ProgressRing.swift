#if os(iOS)
import SwiftUI
import TallylineCore

/// Done over total, from the server's counts. Fills once when it first
/// appears. Never computed from whichever issues the phone happens to hold.
public struct ProgressRing: View {
    public let done: Int
    public let total: Int
    @ScaledMetric(relativeTo: .body) private var diameter: CGFloat = 36
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var systemReduces
    @Environment(\.appReducesMotion) private var appReduces

    public init(done: Int, total: Int) {
        self.done = done
        self.total = total
    }

    private var fraction: Double { ProgressMath.fraction(done: done, total: total) }

    public var body: some View {
        ZStack {
            Circle().stroke(Theme.liningStrong, lineWidth: 3)
            Circle()
                .trim(from: 0, to: shown ? fraction : 0)
                .stroke(fraction >= 1 ? Theme.healthy : Theme.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(done)")
                .font(.caption2.monospacedDigit().weight(.medium))
                .foregroundStyle(Theme.ink)
                .contentTransition(.numericText())
        }
        .frame(width: diameter, height: diameter)
        .motion(.hero, value: fraction)
        .onAppear {
            withAnimation(Motion.animation(.hero, reduceMotion: systemReduces || appReduces)) { shown = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(done) of \(total) done")
    }
}

#Preview("Rings") {
    HStack(spacing: 16) {
        ProgressRing(done: 0, total: 0)
        ProgressRing(done: 3, total: 8)
        ProgressRing(done: 8, total: 8)
    }
    .padding()
    .background(Theme.canvas)
}

#Preview("Rings, dark") {
    HStack(spacing: 16) {
        ProgressRing(done: 0, total: 0)
        ProgressRing(done: 3, total: 8)
        ProgressRing(done: 8, total: 8)
    }
    .padding()
    .background(Theme.canvas)
    .preferredColorScheme(.dark)
}
#endif
