#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// Projects with a progress ring from the server's counts. A project the
/// summary does not mention still shows, as an empty ring.
struct ProjectListView: View {
    var session: SessionModel
    let projects: [Project]
    let summary: RoadmapSummary?
    /// Set on iPad, where the list drives a detail column.
    var selection: Binding<String?>?
    let onCreate: () -> Void

    var body: some View {
        Group {
            if projects.isEmpty {
                ContentUnavailableView {
                    Label("No projects", systemImage: "square.stack.3d.up")
                } description: {
                    Text("Projects group issues toward a goal.")
                } actions: {
                    Button("New project", action: onCreate)
                        .buttonStyle(.borderedProminent)
                }
            } else {
                if let selection {
                    List(projects, selection: selection) { project in
                        ProjectRow(project: project, counts: summary?.counts(forProject: project.id))
                            .tag(project.id)
                            .hoverEffect(.highlight)
                    }
                } else {
                    List(projects) { project in
                        NavigationLink(value: project) { ProjectRow(project: project, counts: summary?.counts(forProject: project.id)) }
                    }
                }
            }
        }
        .refreshable { await session.refresh() }
    }
}

struct ProjectRow: View {
    let project: Project
    let counts: RoadmapSummary.ProjectCounts?

    var body: some View {
        HStack(spacing: 12) {
            ProgressRing(done: counts?.done ?? 0, total: counts?.total ?? 0)
            VStack(alignment: .leading, spacing: 4) {
                Text(project.name).font(.body).foregroundStyle(Theme.ink).lineLimit(2)
                HStack(spacing: 8) {
                    Text(ProjectOrdering.label(project.status))
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Theme.surface3, in: Capsule())
                        .foregroundStyle(Theme.inkMuted)
                    if let target = project.targetDate {
                        Text(target, format: .dateTime.month(.abbreviated).day())
                            .font(.caption2)
                            .foregroundStyle(Theme.inkSubtle)
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }

    private var label: String {
        var parts = [project.name, ProjectOrdering.label(project.status), "\(counts?.done ?? 0) of \(counts?.total ?? 0) issues done"]
        if let target = project.targetDate { parts.append("target \(target.formatted(date: .abbreviated, time: .omitted))") }
        return parts.joined(separator: ", ")
    }
}
#endif
