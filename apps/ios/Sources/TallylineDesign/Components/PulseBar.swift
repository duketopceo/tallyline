#if os(iOS)
import SwiftUI
import TallylineCore

/// The agent pulse: one read-only line about what agents are doing and what
/// is waiting on you. Tapping it goes to whatever needs attention.
public struct PulseBar: View {
    public let summary: PulseSummary
    public let action: () -> Void

    public init(summary: PulseSummary, action: @escaping () -> Void) {
        self.summary = summary
        self.action = action
    }

    private var line: String {
        guard let asOf = summary.asOf else { return summary.text }
        return "\(summary.text) · as of \(asOf.formatted(date: .omitted, time: .shortened))"
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if summary.online {
                    Glint(pulsing: !summary.isIdle)
                } else {
                    Image(systemName: "wifi.slash").font(.footnote).foregroundStyle(Theme.inkMuted)
                }
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                    .contentTransition(.numericText())
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .motion(.standard, value: summary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line)
        .accessibilityHint(summary.tapTarget == .review ? "Opens Review" : "Opens the outbox")
        .accessibilityAddTraits(.isButton)
    }
}

#if DEBUG
#Preview("Pulse") {
    VStack(spacing: 0) {
        PulseBar(summary: PulseSummary(agentsWorking: 2, inReview: 3, waitingToSend: 1, online: true)) {}
        Divider()
        PulseBar(summary: PulseSummary(agentsWorking: 0, inReview: 0, waitingToSend: 0, online: true)) {}
        Divider()
        PulseBar(summary: PulseSummary(agentsWorking: 0, inReview: 0, waitingToSend: 2, online: false)) {}
    }
    .background(.bar)
}

#Preview("Pulse, dark") {
    PulseBar(summary: PulseSummary(agentsWorking: 1, inReview: 2, waitingToSend: 0, online: true, asOf: Date())) {}
        .background(.bar)
        .preferredColorScheme(.dark)
}
#endif
#endif
