# GitHub Timeline Tracker

A local-only web app that visualizes your GitHub commit activity: which repos you
committed to on each day, how many commits per repo, the elapsed time between the
first and last commit of that day in that repo, and daily totals across all repos.

## What it shows

For every day in the selected range:

- **A timeline row per repo** — a bar on a 0–24h axis spanning that repo's first to
  last commit of the day.
- **Commit count** per repo per day.
- **Span** per repo per day (last commit − first commit; `0m` for a single commit).
- **Day totals** — total commits, distinct repos, earliest/latest commit,
  *total span* (wall clock from the day's first commit to its last) and
  *summed span* (the sum of each repo's individual span). These differ whenever
  you work in more than one repo, so both are reported.
- **Range summary** — the same rollups across the whole selected range.

All times use your browser's local timezone, and day boundaries are computed locally.

## Setup

```bash
npm install
npm run dev
```

Then open the printed URL.

### Token

You can use either token type.

**Fine-grained token (recommended — least privilege):**

- Repository access: all repositories, or hand-pick the ones you care about
- Permissions: **Contents → Read-only** and **Metadata → Read-only**

**Classic token:**

- `repo` — required to see commits in private repositories
- `read:user` — required to read your contribution data

Note that ticking `repo` on a classic token automatically includes all of its
sub-scopes (`repo:status`, `repo_deployment`, `public_repo`, `repo:invite`,
`security_events`). GitHub bundles these; they cannot be unchecked individually.
The app only ever reads commit history and never writes, but the grant itself is
broad — which is why a fine-grained token is the better choice.

If you only care about **public** repositories, a classic token with just
`public_repo` is sufficient and much narrower.

Paste the token into the token field in the app. It is stored in your browser's
`localStorage` and sent only to `api.github.com`. It is never written to disk in
this repository and nothing is committed.

## Scripts

| Command         | Description                         |
| --------------- | ----------------------------------- |
| `npm run dev`   | Start the dev server                |
| `npm run build` | Type-check and build for production |
| `npm test`      | Run the aggregation unit tests      |
| `npm run lint`  | Lint the source                     |

## How data is fetched

1. `viewer { login, id }` validates the token and identifies you.
2. `contributionsCollection.commitContributionsByRepository` finds the repos you
   committed to in the range. GitHub caps this at a one-year window, so longer
   ranges are split into successive one-year chunks.
3. If that returns nothing or errors — which can happen with fine-grained tokens,
   whose GraphQL contribution support is inconsistent — the app falls back to
   listing your affiliated repositories and keeping those pushed to within the
   range. This over-selects (`pushedAt` is repo-wide, not per-author), but step 4
   filters back down to your own commits. The UI tells you when the fallback is
   in use.
4. For each repo, `defaultBranchRef.target.history(author, since, until)` pulls
   your commit timestamps, paginated 100 at a time.

### All-branches mode

`contributionsCollection` and default-branch history both only see **merged**
work, so a commit sitting on an unmerged feature branch is invisible to them.
Enabling **Include all branches** changes discovery in two ways:

- The repo list becomes the union of contributed repos *and* affiliated repos
  pushed within the range, so repos active only on a side branch are included.
- Each repo's branches are enumerated via `refs(refPrefix: "refs/heads/")` and
  every branch's history is scanned, de-duplicated by commit SHA.

Why this costs more: git history can only be walked backwards from a ref tip,
and there is no "all commits by author" index. The default branch needs one
walk; every additional branch needs its own.

Two things keep the cost down:

- Branches whose **tip commit predates the range** are skipped without being
  walked. History only goes backwards, so such a branch cannot contain anything
  in range.
- The default branch is not walked twice.

It remains off by default because cost still scales with the number of *active*
branches across candidate repos, not with the number of repos.

Remaining API quota is displayed after each load.

### Excluding public repos

Enabling **Exclude public repo commits** filters the result down to commits on
private repositories only. Each repo's `isPrivate` flag is read alongside its
commit history (no extra requests), and repos whose visibility can't be
determined are kept rather than silently dropped.

## Known limitations

- **Default branch by default.** Commits are read from each repository's default
  branch unless **Include all branches** is enabled. Work on an unmerged feature
  branch will not appear until you turn that on (or until it merges).
- **Author matching** uses your GitHub user ID, so commits authored under an email
  not linked to your account won't appear.
- **Merge commits are included.**
- `contributionsCollection` returns at most 100 repositories per one-year chunk,
  and only counts commits on default branches — this is why all-branches mode also
  scans your affiliated repositories.
