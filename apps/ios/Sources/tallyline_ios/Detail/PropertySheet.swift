#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

struct PropertyOption: Identifiable, Hashable {
    let id: String
    let title: String
    var systemImage: String?
    var detail: String?
}

struct PropertyGroup: Identifiable {
    var id: String { title ?? "options" }
    var title: String?
    var options: [PropertyOption]
}

/// A picker for one property, shown in a medium or large sheet. Single
/// choices commit on tap; multiple choices (labels) commit on Done.
struct PropertySheet: View {
    let title: String
    let groups: [PropertyGroup]
    let selection: Set<String>
    var allowsMultiple = false
    /// Offered at the top for single choices that can be unset ("No project").
    var clearTitle: String?
    let onCommit: (Set<String>) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var chosen: Set<String> = []

    var body: some View {
        NavigationStack {
            List {
                if let clearTitle, !allowsMultiple {
                    Button {
                        onCommit([])
                        dismiss()
                    } label: {
                        row(PropertyOption(id: "", title: clearTitle, systemImage: "minus.circle"), selected: selection.isEmpty)
                    }
                }
                ForEach(groups) { group in
                    Section {
                        ForEach(group.options) { option in
                            Button { tap(option) } label: { row(option, selected: chosen.contains(option.id)) }
                        }
                    } header: {
                        if let title = group.title { Text(title) }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if allowsMultiple {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            onCommit(chosen)
                            dismiss()
                        }
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear { chosen = selection }
    }

    private func row(_ option: PropertyOption, selected: Bool) -> some View {
        HStack(spacing: 12) {
            if let symbol = option.systemImage {
                Image(systemName: symbol).foregroundStyle(Theme.inkMuted).frame(width: 24)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(option.title).foregroundStyle(Theme.ink)
                if let detail = option.detail {
                    Text(detail).font(.caption).foregroundStyle(Theme.inkMuted)
                }
            }
            Spacer()
            if selected {
                Image(systemName: "checkmark").foregroundStyle(Theme.accent)
            }
        }
        .contentShape(Rectangle())
    }

    private func tap(_ option: PropertyOption) {
        if allowsMultiple {
            if chosen.contains(option.id) { chosen.remove(option.id) } else { chosen.insert(option.id) }
        } else {
            onCommit([option.id])
            dismiss()
        }
    }
}

extension PropertyOption {
    static func state(_ state: IssueState) -> PropertyOption {
        PropertyOption(id: state.rawValue, title: state.displayName, systemImage: StateGlyph.symbol(for: state))
    }

    static func priority(_ priority: IssuePriority) -> PropertyOption {
        PropertyOption(id: priority.rawValue, title: priority.displayName)
    }
}

extension PickerCatalog {
    var projectGroups: [PropertyGroup] {
        [PropertyGroup(options: projects.map { PropertyOption(id: $0.id, title: $0.name, systemImage: "square.stack.3d.up") })]
    }

    var cycleGroups: [PropertyGroup] {
        [PropertyGroup(options: cycles.map { PropertyOption(id: $0.id, title: $0.title, systemImage: "arrow.triangle.2.circlepath") })]
    }

    var labelGroups: [PropertyGroup] {
        [PropertyGroup(options: labels.map { PropertyOption(id: $0.id, title: $0.name, systemImage: "tag") })]
    }

    var teamGroups: [PropertyGroup] {
        [PropertyGroup(options: teams.map { PropertyOption(id: $0.id, title: $0.name, systemImage: "person.2", detail: $0.key) })]
    }

    /// People first, then agents. People are chosen by user id, the id the
    /// API assigns by.
    var assigneeGroups: [PropertyGroup] {
        var groups: [PropertyGroup] = []
        let people = members.compactMap { member -> PropertyOption? in
            guard let userId = member.userId else { return nil }
            return PropertyOption(id: "human:\(userId)", title: member.title, systemImage: "person.crop.circle")
        }
        if !people.isEmpty { groups.append(PropertyGroup(title: "People", options: people)) }
        let robots = agents.map { PropertyOption(id: "agent:\($0.id)", title: $0.name, systemImage: "sparkles", detail: $0.harness) }
        if !robots.isEmpty { groups.append(PropertyGroup(title: "Agents", options: robots)) }
        return groups
    }
}

#if DEBUG
private let previewGroups = [
    PropertyGroup(title: "People", options: [
        PropertyOption(id: "human:1", title: "Ada Lovelace", systemImage: "person.crop.circle"),
        PropertyOption(id: "human:2", title: "Grace Hopper", systemImage: "person.crop.circle"),
    ]),
    PropertyGroup(title: "Agents", options: [
        PropertyOption(id: "agent:1", title: "Builder", systemImage: "sparkles", detail: "claude-code"),
    ]),
]

#Preview("Property sheet") {
    PropertySheet(title: "Assignee", groups: previewGroups, selection: ["agent:1"], clearTitle: "Unassigned") { _ in }
}

#Preview("Property sheet, dark") {
    PropertySheet(title: "Assignee", groups: previewGroups, selection: ["human:2"], clearTitle: "Unassigned") { _ in }
        .preferredColorScheme(.dark)
}
#endif
#endif
