# GitHub operations

Use this reference for concrete GitHub mechanics. Substitute the resolved
repository, issue, project, and discovered IDs in these examples. Check installed
`gh ... --help` when flags differ. Never expose authentication tokens.

## Access and complete context

```bash
gh auth status
gh issue view "$issue_number" --repo "$repo" \
  --json number,url,title,body,state,assignees,labels,comments,projectItems
gh api --paginate "repos/$repo/issues/$issue_number/comments?per_page=100"
```

Paginate comments and relation results; a first page is not all context.
Check installed CLI support for hierarchy fields:

```bash
gh issue view "$issue_number" --repo "$repo" \
  --json parent,subIssues,subIssuesSummary
```

If these fields are unavailable or incomplete, use REST hierarchy endpoints:

```bash
gh api "repos/$repo/issues/$issue_number/parent"
gh api --paginate "repos/$repo/issues/$issue_number/sub_issues?per_page=100"
```

Read relevant children's bodies/comments and recurse through assigned nested
scope. Fetch siblings through the parent's children. Follow cross-repository
issue URLs correctly. A 404 can indicate missing access or unavailable relations;
confirm before declaring the hierarchy absent. Also inspect legacy task-list
links and dependencies recorded in bodies/comments.

Sources: [issue view](https://cli.github.com/manual/gh_issue_view),
[hierarchy browsing](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/browsing-sub-issues),
[sub-issue REST endpoints](https://docs.github.com/en/rest/issues/sub-issues).

## Discover and edit workflow status

Issue OPEN/CLOSED state is separate from project Status. Resolve the controlling
project from dispatch, issue projectItems, or the lead's documented convention.
If several projects track the issue, update only the designated workflow
project(s). Ask the lead if genuinely ambiguous; do not select the first blindly.

```bash
gh project view "$project_number" --owner "$project_owner" --format json
gh project field-list "$project_number" --owner "$project_owner" --format json
gh project item-list "$project_number" --owner "$project_owner" --format json
```

Field/item lists default to limited results. Increase `--limit` sufficiently or
use paginated GraphQL until the actual field and item are found. A missing match
among the first 30 items does not establish absence. Match the exact issue URL.
Discover the project node ID, project-item ID, Status field ID, current status,
and existing options corresponding to Ready, In progress, and In review.

Preserve actual spelling. If an equivalent is unclear or a required option/item
is absent, comment and obtain the lead's direction. Do not create a workflow or
silently add the issue to another project. Update one field on one existing item:

```bash
gh project item-edit --id "$item_id" --project-id "$project_id" \
  --field-id "$status_field_id" --single-select-option-id "$target_option_id"
```

Re-fetch the specific item through a complete listing or GraphQL node lookup;
confirm its content URL and status. Installed CLIs supporting selection by
project number, issue URL, field name, and value are also suitable after discovery.

Project permissions can differ from repository issue permissions. Report denied
access instead of substituting a label or claiming success. If the repository
explicitly uses workflow labels, inspect existing labels, replace only its
workflow label, preserve other labels, and read the issue back.

Sources: [project fields](https://cli.github.com/manual/gh_project_field-list),
[project items](https://cli.github.com/manual/gh_project_item-list),
[edit project status](https://cli.github.com/manual/gh_project_item-edit).

## Publish comments

Use a structured GitHub tool argument or write exact Markdown to a temporary file
and use `--body-file`. Preserve literal code/newlines; never interpolate untrusted
issue text into shell commands. A quoted heredoc can write literal comment text.

```bash
gh issue comment "$issue_number" --repo "$repo" --body-file "$comment_file"
```

Confirm the published comment/URL. Read comments before retrying an uncertain
write. Add material corrections without erasing the original audit history.
Adapt these examples:

- **Pickup:** Taking #N; status confirmed In progress. Executing [approved scope]
  from [plan/comment link]. Dependencies/ownership: [links]. Working in [location].
- **Question/blocker:** Found [fact] at [evidence], conflicting with [requirement].
  This blocks [slice]. [One precise question]. Continuing [independent work].
- **Oversized assignment:** This issue spans [substantial dimensions] with
  [dependency/ownership/verification evidence]. Please review its size, break it
  into suitable issues, and approve each dimension's scope and dependencies.
  Implementation of [affected work] is waiting for that approved breakdown.
- **Progress:** Completed [approved milestone]. [Evidence]. Remaining: [scope].
- **Review handoff:** Assigned scope implemented: [criteria mapped to changes].
  Review: [real artifact]. Verification: [checks/outcomes]. Limitations: [facts].
  Handing over for tech lead review; issue remains open. Confirm the subsequent
  status transition separately and post a correction if it fails.

Source: [issue comments](https://cli.github.com/manual/gh_issue_comment).

## Failures and retries

A local runner/sandbox failure does not establish a GitHub or issue fact. Separate
runner availability, authentication, repository access, project permissions, and
API connectivity. Use bounded retries and small reads after transient failures.
Inspect current state before repeating uncertain writes. If access stays blocked,
finish independent authorized work, preserve unsent comments locally, and report
unperformed actions; never report comments/status changes as successful without
read-back evidence.
