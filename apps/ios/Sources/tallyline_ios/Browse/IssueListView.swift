#if os(iOS)
import SwiftUI
import UIKit
import TallylineCore
import TallylineDesign

/// Issues grouped by state, with pull-to-refresh and delta reloads. Swipe
/// right to move forward, swipe left to take it, long-press for the rest.
struct IssueListView: View {
    var session: SessionModel
    let credential: DeviceCredential
    let state: IssueState?
    @State private var error: String?
    @State private var actionError: String?
    @State private var showCreate = false
    @State private var committedSwipes = 0
    @Namespace private var zoom

    private var issues: [Issue] {
        session.offline.cachedIssues(workspaceSlug: credential.workspaceSlug, state: state)
    }

    private var actions: IssueActions { IssueActions(session: session, credential: credential) }

    var body: some View {
        NavigationStack {
            Group {
                if issues.isEmpty, let error {
                    ContentUnavailableView("Couldn't load", systemImage: "exclamationmark.triangle", description: Text(error))
                } else if issues.isEmpty {
                    ContentUnavailableView("Nothing here", systemImage: "checkmark", description: Text("No issues in this list."))
                } else {
                    list
                }
            }
            .navigationTitle(state?.displayName ?? "Issues")
            .navigationDestination(for: Issue.self) { issue in
                IssueDetailView(session: session, credential: credential, issue: issue)
                    .navigationTransition(.zoom(sourceID: issue.id, in: zoom))
            }
            .toolbar {
                ProfileToolbarItem(session: session)
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showCreate = true } label: { Image(systemName: "plus") }
                        .keyboardShortcut("n", modifiers: .command)
                        .accessibilityLabel("New issue")
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button { Task { await reload() } } label: { Image(systemName: "arrow.clockwise") }
                        .keyboardShortcut("r", modifiers: .command)
                        .accessibilityLabel("Refresh")
                }
            }
            .refreshable { await reload() }
            .task { await reload() }
            .sheet(isPresented: $showCreate) {
                CreateIssueView(session: session, credential: credential) { await reload() }
            }
            .sensoryFeedback(.impact(weight: .light), trigger: committedSwipes)
        }
    }

    private var list: some View {
        List {
            if error != nil || !session.offline.isOnline {
                Label("Offline. Showing issues saved on this phone.", systemImage: "wifi.slash")
                    .font(.footnote)
                    .foregroundStyle(Theme.inkMuted)
            }
            if let actionError {
                Label(actionError, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Theme.urgent)
            }
            ForEach(IssueGrouping.sections(issues), id: \.state) { section in
                Section {
                    ForEach(section.issues) { issue in
                        row(issue)
                    }
                } header: {
                    if state == nil {
                        Text(section.state.displayName)
                            .font(.footnote.smallCaps())
                            .foregroundStyle(Theme.inkMuted)
                    }
                }
            }
        }
        .motion(.standard, value: issues.map(\.state))
        // VoiceOver rotors: jump straight to what needs attention.
        .accessibilityRotor("Urgent and high") {
            ForEach(issues.filter { $0.priority == .urgent || $0.priority == .high }) { issue in
                AccessibilityRotorEntry(IssueSpeech.label(issue), id: issue.id)
            }
        }
        .accessibilityRotor("In review") {
            ForEach(issues.filter { $0.state == .inReview }) { issue in
                AccessibilityRotorEntry(IssueSpeech.label(issue), id: issue.id)
            }
        }
        .accessibilityRotor("Agent work") {
            ForEach(issues.filter { $0.creatorType == "agent" }) { issue in
                AccessibilityRotorEntry(IssueSpeech.label(issue), id: issue.id)
            }
        }
    }

    private func row(_ issue: Issue) -> some View {
        NavigationLink(value: issue) { IssueRowView(issue: issue) }
            .matchedTransitionSource(id: issue.id, in: zoom)
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                if let next = issue.state.forward {
                    Button { run { await actions.move(issue, to: next) } } label: {
                        Label(next.displayName, systemImage: StateGlyph.symbol(for: next))
                    }
                    .tint(Theme.accent)
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                if issue.assigneeId != credential.userId {
                    Button { run { await actions.assignToMe(issue) } } label: {
                        Label("Assign to me", systemImage: "person.crop.circle.badge.checkmark")
                    }
                    .tint(Theme.neutral)
                }
            }
            .contextMenu {
                Button { UIPasteboard.general.string = issue.key } label: {
                    Label("Copy key", systemImage: "doc.on.doc")
                }
                if issue.assigneeId != credential.userId {
                    Button { run { await actions.assignToMe(issue) } } label: {
                        Label("Assign to me", systemImage: "person.crop.circle.badge.checkmark")
                    }
                }
                if !issue.state.transitions.isEmpty {
                    Menu("Change state", systemImage: "arrow.triangle.swap") {
                        ForEach(issue.state.transitions, id: \.self) { next in
                            Button { run { await actions.move(issue, to: next) } } label: {
                                Label(next.displayName, systemImage: StateGlyph.symbol(for: next))
                            }
                        }
                    }
                }
            }
    }

    /// Runs a write, counts the swipe for haptics, and shows a refusal inline.
    private func run(_ write: @escaping () async -> SubmitOutcome) {
        committedSwipes += 1
        Task {
            if case .rejected(let reason) = await write() {
                actionError = reason
            } else {
                actionError = nil
            }
        }
    }

    private func reload() async {
        do {
            try await session.offline.syncIssues(workspaceSlug: credential.workspaceSlug)
            error = nil
        } catch let APIClientError.http(_, _, message) {
            self.error = message ?? "The server could not load this list."
        } catch {
            self.error = "You're offline"
        }
    }
}

/// An issue key to open in a sheet (deep links and shortcuts).
struct OpenIssueKey: Identifiable {
    let id: String
}
#endif
