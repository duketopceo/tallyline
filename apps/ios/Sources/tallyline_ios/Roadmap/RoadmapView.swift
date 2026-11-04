#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// A month grid with a lane each for cycles, projects and milestones. Counts
/// come from the server's roadmap summary; the today marker follows the
/// device's calendar.
struct RoadmapView: View {
    var workspace: WorkspaceModel
    let onOpenProject: (Project) -> Void

    private let monthWidth: CGFloat = 132
    private let rowHeight: CGFloat = 48
    @Environment(\.accessibilityReduceMotion) private var systemReducesMotion
    @Environment(\.appReducesMotion) private var appReducesMotion

    private var spans: [RoadmapSpan] {
        RoadmapLayout.spans(projects: workspace.projects, milestones: workspace.milestones, cycles: workspace.cycles, summary: workspace.summary)
    }

    var body: some View {
        if workspace.projects.isEmpty && workspace.milestones.isEmpty && workspace.cycles.isEmpty {
            ContentUnavailableView("Nothing scheduled", systemImage: "calendar", description: Text("Projects, cycles and milestones with dates appear here."))
        } else {
            grid(spans: spans)
        }
    }

    private func grid(spans: [RoadmapSpan]) -> some View {
        let months = RoadmapLayout.months(for: spans)
        let width = CGFloat(months.count) * monthWidth
        let today = CGFloat(RoadmapLayout.position(of: Date(), in: months)) * monthWidth
        return ScrollViewReader { proxy in
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    Section {
                        ForEach(RoadmapSpan.Lane.allCases, id: \.self) { lane in
                            let laneSpans = spans.filter { $0.lane == lane }
                            if !laneSpans.isEmpty {
                                Text(lane.title)
                                    .font(.footnote.smallCaps())
                                    .foregroundStyle(Theme.inkMuted)
                                    .padding(.leading, 12)
                                    .padding(.vertical, 8)
                                ForEach(laneSpans) { span in
                                    bar(span, months: months)
                                }
                            }
                        }
                    } header: {
                        monthHeader(months)
                    }
                }
                .frame(width: width, alignment: .leading)
                .background(alignment: .topLeading) { gridLines(months) }
                .overlay(alignment: .topLeading) {
                    Rectangle()
                        .fill(Theme.accent)
                        .frame(width: 1.5)
                        .offset(x: today)
                        .id("today")
                        .accessibilityHidden(true)
                }
            }
            .onAppear { proxy.scrollTo("today", anchor: .center) }
        }
        .background(Theme.canvas)
    }

    private func monthHeader(_ months: [Date]) -> some View {
        HStack(spacing: 0) {
            ForEach(months, id: \.self) { month in
                Text(month, format: .dateTime.month(.abbreviated).year(.twoDigits))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.inkMuted)
                    .frame(width: monthWidth, alignment: .leading)
                    .padding(.leading, 8)
                    .padding(.vertical, 8)
            }
        }
        .background(Theme.surface1)
    }

    private func gridLines(_ months: [Date]) -> some View {
        HStack(spacing: 0) {
            ForEach(months, id: \.self) { _ in
                Rectangle().fill(Theme.liningFaint).frame(width: 1)
                Spacer(minLength: 0).frame(width: monthWidth - 1)
            }
        }
    }

    @ViewBuilder
    private func bar(_ span: RoadmapSpan, months: [Date]) -> some View {
        let x = CGFloat(RoadmapLayout.position(of: span.start, in: months)) * monthWidth
        let rawWidth = CGFloat(RoadmapLayout.position(of: span.end, in: months)) * monthWidth - x
        let isPoint = span.lane == .milestones
        let width = isPoint ? 0 : max(rawWidth, 72)
        let content = HStack(spacing: 8) {
            if let done = span.done, let total = span.total {
                ProgressRing(done: done, total: total)
            }
            Text(span.title)
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .frame(width: isPoint ? nil : width, height: rowHeight - 8, alignment: .leading)
        .background(isPoint ? Theme.surface3 : Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radiusLg))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg).strokeBorder(Theme.lining, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label(span))

        let target = project(for: span)
        Group {
            if let target {
                Button { onOpenProject(target) } label: { content }.buttonStyle(.plain)
            } else {
                content
            }
        }
        .modifier(EdgeFade(enabled: !(systemReducesMotion || appReducesMotion)))
        .offset(x: x)
        .frame(width: CGFloat(months.count) * monthWidth, height: rowHeight, alignment: .leading)
    }

    private func project(for span: RoadmapSpan) -> Project? {
        let id: String?
        if span.id.hasPrefix("project:") {
            id = String(span.id.dropFirst("project:".count))
        } else if span.id.hasPrefix("milestone:") {
            let mid = String(span.id.dropFirst("milestone:".count))
            id = workspace.milestones.first { $0.id == mid }?.projectId
        } else {
            id = nil
        }
        return workspace.projects.first { $0.id == id }
    }

    private func label(_ span: RoadmapSpan) -> String {
        var parts = [span.lane.title.dropLast().description, span.title]
        if let done = span.done, let total = span.total { parts.append("\(done) of \(total) done") }
        parts.append(span.start.formatted(date: .abbreviated, time: .omitted))
        if span.end != span.start { parts.append("to \(span.end.formatted(date: .abbreviated, time: .omitted))") }
        return parts.joined(separator: ", ")
    }
}

/// Bars fade as they leave the visible edge. Off under Reduce Motion.
private struct EdgeFade: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled {
            content.scrollTransition(axis: .horizontal) { view, phase in
                view.opacity(phase.isIdentity ? 1 : 0.4)
            }
        } else {
            content
        }
    }
}
#endif
