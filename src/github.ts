import type { Commit, RateLimit } from "./types";

const GRAPHQL_URL = "https://api.github.com/graphql";

export class GitHubError extends Error {}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

let lastRateLimit: RateLimit | null = null;

export function getRateLimit(): RateLimit | null {
  return lastRateLimit;
}

async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401) {
    throw new GitHubError("Invalid or expired token (401 Unauthorized).");
  }
  if (!res.ok) {
    throw new GitHubError(`GitHub API error ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as GraphQLResponse<T & { rateLimit?: RateLimit }>;
  if (json.errors?.length) {
    throw new GitHubError(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) throw new GitHubError("GitHub returned an empty response.");
  if (json.data.rateLimit) lastRateLimit = json.data.rateLimit;
  return json.data;
}

export async function fetchViewerLogin(token: string): Promise<string> {
  const data = await graphql<{ viewer: { login: string } }>(
    token,
    `query { viewer { login } rateLimit { remaining limit resetAt } }`,
    {},
  );
  return data.viewer.login;
}

/**
 * `contributionsCollection` accepts at most a one-year window, so longer
 * ranges are split into successive chunks.
 */
function yearChunks(from: Date, to: Date): { from: Date; to: Date }[] {
  const chunks: { from: Date; to: Date }[] = [];
  let cursor = new Date(from);
  while (cursor < to) {
    const next = new Date(cursor);
    next.setFullYear(next.getFullYear() + 1);
    chunks.push({ from: new Date(cursor), to: next < to ? next : new Date(to) });
    cursor = next;
  }
  return chunks.length ? chunks : [{ from, to }];
}

const CONTRIBUTIONS_QUERY = `
  query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        commitContributionsByRepository(maxRepositories: 100) {
          repository { nameWithOwner }
        }
      }
    }
    rateLimit { remaining limit resetAt }
  }
`;

/** Repos the user made commits to within the range (includes private repos with `repo` scope). */
export async function fetchContributedRepos(
  token: string,
  login: string,
  from: Date,
  to: Date,
): Promise<string[]> {
  const repos = new Set<string>();
  for (const chunk of yearChunks(from, to)) {
    const data = await graphql<{
      user: {
        contributionsCollection: {
          commitContributionsByRepository: {
            repository: { nameWithOwner: string };
          }[];
        };
      } | null;
    }>(token, CONTRIBUTIONS_QUERY, {
      login,
      from: chunk.from.toISOString(),
      to: chunk.to.toISOString(),
    });
    const list =
      data.user?.contributionsCollection.commitContributionsByRepository ?? [];
    for (const entry of list) repos.add(entry.repository.nameWithOwner);
  }
  return [...repos].sort();
}

const AFFILIATED_REPOS_QUERY = `
  query($cursor: String) {
    viewer {
      repositories(
        first: 100
        after: $cursor
        affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
        orderBy: { field: PUSHED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { nameWithOwner isArchived pushedAt }
      }
    }
    rateLimit { remaining limit resetAt }
  }
`;

/**
 * Fallback repo discovery for tokens where `contributionsCollection` yields
 * nothing (notably fine-grained tokens, whose GraphQL contribution support is
 * inconsistent). Lists repositories the viewer is affiliated with and keeps
 * those pushed to at or after `from`. `pushedAt` is repo-wide rather than
 * per-author, so this over-selects; the per-repo history query then filters
 * down to the viewer's own commits in range.
 */
export async function fetchAffiliatedRepos(
  token: string,
  from: Date,
): Promise<string[]> {
  const repos: string[] = [];
  let cursor: string | null = null;

  do {
    const data: {
      viewer: {
        repositories: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            nameWithOwner: string;
            isArchived: boolean;
            pushedAt: string | null;
          }[];
        };
      };
    } = await graphql(token, AFFILIATED_REPOS_QUERY, { cursor });

    const page = data.viewer.repositories;
    let exhausted = false;
    for (const node of page.nodes) {
      if (!node.pushedAt) continue;
      if (new Date(node.pushedAt) < from) {
        // Sorted by PUSHED_AT desc, so everything after this is older too.
        exhausted = true;
        break;
      }
      if (!node.isArchived) repos.push(node.nameWithOwner);
    }

    cursor =
      !exhausted && page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return [...new Set(repos)].sort();
}

const HISTORY_QUERY = `
  query($owner: String!, $name: String!, $author: ID!, $since: GitTimestamp!, $until: GitTimestamp!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      isPrivate
      defaultBranchRef {
        target {
          ... on Commit {
            history(author: { id: $author }, since: $since, until: $until, first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { oid committedDate messageHeadline url }
            }
          }
        }
      }
    }
    rateLimit { remaining limit resetAt }
  }
`;

const BRANCH_HISTORY_QUERY = `
  query($owner: String!, $name: String!, $branch: String!, $author: ID!, $since: GitTimestamp!, $until: GitTimestamp!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      ref(qualifiedName: $branch) {
        target {
          ... on Commit {
            history(author: { id: $author }, since: $since, until: $until, first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { oid committedDate messageHeadline url }
            }
          }
        }
      }
    }
    rateLimit { remaining limit resetAt }
  }
`;

const BRANCHES_QUERY = `
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef { name }
      refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          target { ... on Commit { committedDate } }
        }
      }
    }
    rateLimit { remaining limit resetAt }
  }
`;

/**
 * Branches worth walking for commits in `[from, to]`.
 *
 * History walks backwards from a branch tip, so a branch whose tip commit
 * predates `from` cannot contain anything in range — every ancestor is older
 * still. Skipping those avoids a request per stale branch, which is the bulk of
 * the cost in long-lived repos. The default branch is excluded because the
 * caller scans it separately.
 */
export async function fetchRepoBranches(
  token: string,
  repoFullName: string,
  from?: Date,
): Promise<string[]> {
  const [owner, name] = repoFullName.split("/");
  const branches: string[] = [];
  let cursor: string | null = null;
  let defaultBranch: string | null = null;

  do {
    const data: {
      repository: {
        defaultBranchRef: { name: string } | null;
        refs: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            name: string;
            target: { committedDate?: string } | null;
          }[];
        } | null;
      } | null;
    } = await graphql(token, BRANCHES_QUERY, { owner, name, cursor });

    const repository = data.repository;
    if (!repository?.refs) break;
    defaultBranch ??= repository.defaultBranchRef?.name ?? null;

    for (const node of repository.refs.nodes) {
      if (node.name === defaultBranch) continue;
      const tip = node.target?.committedDate;
      if (from && tip && new Date(tip) < from) continue;
      branches.push(node.name);
    }
    cursor = repository.refs.pageInfo.hasNextPage
      ? repository.refs.pageInfo.endCursor
      : null;
  } while (cursor);

  return branches;
}

export async function fetchViewerId(token: string): Promise<string> {
  const data = await graphql<{ viewer: { id: string } }>(
    token,
    `query { viewer { id } rateLimit { remaining limit resetAt } }`,
    {},
  );
  return data.viewer.id;
}

interface HistoryPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: {
    oid: string;
    committedDate: string;
    messageHeadline: string;
    url: string;
  }[];
}

/** Page through one ref's commit history, accumulating into `sink`. */
async function collectHistory(
  token: string,
  repoFullName: string,
  variables: Record<string, unknown>,
  query: string,
  pick: (data: never) => HistoryPage | null | undefined,
  sink: Map<string, Commit>,
  onData?: (data: never) => void,
): Promise<void> {
  let cursor: string | null = null;
  do {
    const data = await graphql<never>(token, query, { ...variables, cursor });
    onData?.(data);
    const history = pick(data);
    if (!history) break;

    for (const node of history.nodes) {
      // De-duplicate by SHA: the same commit is reachable from many branches.
      if (!sink.has(node.oid)) {
        sink.set(node.oid, {
          repo: repoFullName,
          committedAt: node.committedDate,
          oid: node.oid,
          messageHeadline: node.messageHeadline,
          url: node.url,
        });
      }
    }
    cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
  } while (cursor);
}

/**
 * The author's commits in a repo within the range.
 *
 * By default only the default branch is scanned. With `allBranches`, every
 * branch is scanned and results are de-duplicated by commit SHA, so work that
 * hasn't been merged yet still shows up. That costs roughly one extra request
 * per branch.
 */
export interface RepoCommitsResult {
  commits: Commit[];
  /** Null when the repository's visibility couldn't be determined. */
  isPrivate: boolean | null;
}

export async function fetchRepoCommits(
  token: string,
  repoFullName: string,
  authorId: string,
  from: Date,
  to: Date,
  allBranches = false,
): Promise<RepoCommitsResult> {
  const [owner, name] = repoFullName.split("/");
  const base = {
    owner,
    name,
    author: authorId,
    since: from.toISOString(),
    until: to.toISOString(),
  };
  const byOid = new Map<string, Commit>();
  let isPrivate: boolean | null = null;

  await collectHistory(
    token,
    repoFullName,
    base,
    HISTORY_QUERY,
    (d: never) =>
      (d as { repository?: { defaultBranchRef?: { target?: { history?: HistoryPage } } } })
        .repository?.defaultBranchRef?.target?.history,
    byOid,
    (d: never) => {
      if (isPrivate === null) {
        isPrivate =
          (d as { repository?: { isPrivate?: boolean } }).repository?.isPrivate ??
          null;
      }
    },
  );

  if (allBranches) {
    let branches: string[] = [];
    try {
      branches = await fetchRepoBranches(token, repoFullName, from);
    } catch (err) {
      console.warn(`Could not list branches for ${repoFullName}:`, err);
    }

    for (const branch of branches) {
      try {
        await collectHistory(
          token,
          repoFullName,
          { ...base, branch },
          BRANCH_HISTORY_QUERY,
          (d: never) =>
            (d as { repository?: { ref?: { target?: { history?: HistoryPage } } } })
              .repository?.ref?.target?.history,
          byOid,
        );
      } catch (err) {
        console.warn(`Skipping branch ${branch} of ${repoFullName}:`, err);
      }
    }
  }

  return { commits: [...byOid.values()], isPrivate };
}

export interface FetchProgress {
  completed: number;
  total: number;
  current: string;
  /** True when repos came from the affiliated-repos fallback. */
  usedFallback?: boolean;
}

/**
 * Discover the repos to inspect, then pull every commit in the range.
 *
 * Discovery prefers `contributionsCollection`, which is precise. Fine-grained
 * tokens may return nothing (or error) there, so we fall back to enumerating
 * affiliated repositories pushed within the range.
 *
 * When `allBranches` is set, commits on every branch are counted (de-duplicated
 * by SHA) rather than just the default branch. Combined with the affiliated-repo
 * fallback this also catches repos whose only activity is on a feature branch,
 * which contribution data omits until the work is merged.
 *
 * When `excludePublicRepos` is set, commits to public repositories are dropped
 * so only private-repo activity is counted. Repos whose visibility couldn't be
 * determined are kept, to avoid silently under-counting.
 */
export async function fetchCommits(
  token: string,
  from: Date,
  to: Date,
  onProgress?: (progress: FetchProgress) => void,
  allBranches = false,
  excludePublicRepos = false,
): Promise<Commit[]> {
  const login = await fetchViewerLogin(token);
  const authorId = await fetchViewerId(token);

  let repos: string[] = [];
  let usedFallback = false;
  try {
    repos = await fetchContributedRepos(token, login, from, to);
  } catch (err) {
    console.warn("Contribution-based discovery failed, falling back:", err);
  }

  if (allBranches) {
    // Contribution data only counts merged work, so union in affiliated repos
    // to catch those active solely on unmerged branches.
    try {
      const affiliated = await fetchAffiliatedRepos(token, from);
      const merged = new Set([...repos, ...affiliated]);
      usedFallback = repos.length === 0;
      repos = [...merged].sort();
    } catch (err) {
      console.warn("Affiliated-repo discovery failed:", err);
    }
  } else if (repos.length === 0) {
    usedFallback = true;
    repos = await fetchAffiliatedRepos(token, from);
  }

  const all: Commit[] = [];
  for (let i = 0; i < repos.length; i++) {
    onProgress?.({
      completed: i,
      total: repos.length,
      current: repos[i],
      usedFallback,
    });
    try {
      const { commits, isPrivate } = await fetchRepoCommits(
        token,
        repos[i],
        authorId,
        from,
        to,
        allBranches,
      );
      if (excludePublicRepos && isPrivate === false) continue;
      all.push(...commits);
    } catch (err) {
      // A single inaccessible repo shouldn't abort the whole range.
      console.warn(`Skipping ${repos[i]}:`, err);
    }
  }
  onProgress?.({
    completed: repos.length,
    total: repos.length,
    current: "",
    usedFallback,
  });
  return all;
}
