import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAffiliatedRepos, fetchCommits, fetchRepoBranches } from "./github";

interface Handler {
  match: (query: string) => boolean;
  respond: (variables: Record<string, unknown>) => unknown;
}

/** Route GraphQL calls to canned responses based on the query body. */
function mockGraphQL(handlers: Handler[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const { query, variables } = JSON.parse(init.body);
      const handler = handlers.find((h) => h.match(query));
      if (!handler) throw new Error(`Unhandled query: ${query.slice(0, 80)}`);
      calls.push(query);
      return {
        ok: true,
        status: 200,
        json: async () => handler.respond(variables ?? {}),
      };
    }),
  );
  return calls;
}

const viewerLogin: Handler = {
  match: (q) => q.includes("viewer { login }"),
  respond: () => ({ data: { viewer: { login: "me" } } }),
};
const viewerId: Handler = {
  match: (q) => q.includes("viewer { id }"),
  respond: () => ({ data: { viewer: { id: "UID" } } }),
};

function historyHandler(
  byRepo: Record<string, string[]>,
  isPrivateByRepo: Record<string, boolean> = {},
): Handler {
  return {
    match: (q) => q.includes("defaultBranchRef"),
    respond: (vars) => {
      const full = `${vars.owner}/${vars.name}`;
      const dates = byRepo[full] ?? [];
      return {
        data: {
          repository: {
            isPrivate: isPrivateByRepo[full] ?? false,
            defaultBranchRef: {
              target: {
                history: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: dates.map((d, i) => ({
                    oid: `${full}-${i}`,
                    committedDate: d,
                    messageHeadline: "m",
                    url: "#",
                  })),
                },
              },
            },
          },
        },
      };
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

const FROM = new Date(2026, 2, 1);
const TO = new Date(2026, 2, 31);

describe("fetchCommits discovery", () => {
  it("uses contribution data when available", async () => {
    mockGraphQL([
      viewerLogin,
      viewerId,
      {
        match: (q) => q.includes("contributionsCollection"),
        respond: () => ({
          data: {
            user: {
              contributionsCollection: {
                commitContributionsByRepository: [
                  { repository: { nameWithOwner: "me/alpha" } },
                ],
              },
            },
          },
        }),
      },
      historyHandler({
        "me/alpha": [new Date(2026, 2, 5, 10, 0).toISOString()],
      }),
    ]);

    const progress: boolean[] = [];
    const commits = await fetchCommits(
      "t",
      FROM,
      TO,
      (p) => progress.push(!!p.usedFallback),
    );

    expect(commits.map((c) => c.repo)).toEqual(["me/alpha"]);
    expect(progress.every((f) => f === false)).toBe(true);
  });

  it("falls back to affiliated repos when contributions are empty", async () => {
    mockGraphQL([
      viewerLogin,
      viewerId,
      {
        match: (q) => q.includes("contributionsCollection"),
        respond: () => ({
          data: {
            user: {
              contributionsCollection: {
                commitContributionsByRepository: [],
              },
            },
          },
        }),
      },
      {
        match: (q) => q.includes("affiliations"),
        respond: () => ({
          data: {
            viewer: {
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    nameWithOwner: "me/beta",
                    isArchived: false,
                    pushedAt: new Date(2026, 2, 20).toISOString(),
                  },
                ],
              },
            },
          },
        }),
      },
      historyHandler({
        "me/beta": [new Date(2026, 2, 20, 9, 0).toISOString()],
      }),
    ]);

    const progress: boolean[] = [];
    const commits = await fetchCommits("t", FROM, TO, (p) =>
      progress.push(!!p.usedFallback),
    );

    expect(commits.map((c) => c.repo)).toEqual(["me/beta"]);
    expect(progress.some((f) => f === true)).toBe(true);
  });

  it("falls back when the contributions query errors", async () => {
    mockGraphQL([
      viewerLogin,
      viewerId,
      {
        match: (q) => q.includes("contributionsCollection"),
        respond: () => ({ errors: [{ message: "not supported" }] }),
      },
      {
        match: (q) => q.includes("affiliations"),
        respond: () => ({
          data: {
            viewer: {
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    nameWithOwner: "me/gamma",
                    isArchived: false,
                    pushedAt: new Date(2026, 2, 10).toISOString(),
                  },
                ],
              },
            },
          },
        }),
      },
      historyHandler({
        "me/gamma": [new Date(2026, 2, 10, 8, 0).toISOString()],
      }),
    ]);

    const commits = await fetchCommits("t", FROM, TO);
    expect(commits.map((c) => c.repo)).toEqual(["me/gamma"]);
  });

  it("keeps going when one repo's history is inaccessible", async () => {
    mockGraphQL([
      viewerLogin,
      viewerId,
      {
        match: (q) => q.includes("contributionsCollection"),
        respond: () => ({
          data: {
            user: {
              contributionsCollection: {
                commitContributionsByRepository: [
                  { repository: { nameWithOwner: "me/ok" } },
                  { repository: { nameWithOwner: "me/denied" } },
                ],
              },
            },
          },
        }),
      },
      {
        match: (q) => q.includes("defaultBranchRef"),
        respond: (vars) => {
          if (vars.name === "denied") {
            return { errors: [{ message: "Forbidden" }] };
          }
          return {
            data: {
              repository: {
                defaultBranchRef: {
                  target: {
                    history: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          oid: "1",
                          committedDate: new Date(2026, 2, 4, 9, 0).toISOString(),
                          messageHeadline: "m",
                          url: "#",
                        },
                      ],
                    },
                  },
                },
              },
            },
          };
        },
      },
    ]);

    const commits = await fetchCommits("t", FROM, TO);
    expect(commits.map((c) => c.repo)).toEqual(["me/ok"]);
  });
});

describe("excludePublicRepos", () => {
  it("drops commits from public repos when enabled", async () => {
    mockGraphQL([
      viewerLogin,
      viewerId,
      {
        match: (q) => q.includes("contributionsCollection"),
        respond: () => ({
          data: {
            user: {
              contributionsCollection: {
                commitContributionsByRepository: [
                  { repository: { nameWithOwner: "me/public-repo" } },
                  { repository: { nameWithOwner: "me/private-repo" } },
                ],
              },
            },
          },
        }),
      },
      historyHandler(
        {
          "me/public-repo": [new Date(2026, 2, 5, 10, 0).toISOString()],
          "me/private-repo": [new Date(2026, 2, 6, 10, 0).toISOString()],
        },
        { "me/public-repo": false, "me/private-repo": true },
      ),
    ]);

    const commits = await fetchCommits(
      "t",
      FROM,
      TO,
      undefined,
      false,
      true,
    );

    expect(commits.map((c) => c.repo)).toEqual(["me/private-repo"]);
  });

  it("keeps commits from every repo when disabled", async () => {
    mockGraphQL([
      viewerLogin,
      viewerId,
      {
        match: (q) => q.includes("contributionsCollection"),
        respond: () => ({
          data: {
            user: {
              contributionsCollection: {
                commitContributionsByRepository: [
                  { repository: { nameWithOwner: "me/public-repo" } },
                  { repository: { nameWithOwner: "me/private-repo" } },
                ],
              },
            },
          },
        }),
      },
      historyHandler(
        {
          "me/public-repo": [new Date(2026, 2, 5, 10, 0).toISOString()],
          "me/private-repo": [new Date(2026, 2, 6, 10, 0).toISOString()],
        },
        { "me/public-repo": false, "me/private-repo": true },
      ),
    ]);

    const commits = await fetchCommits("t", FROM, TO);

    expect(commits.map((c) => c.repo).sort()).toEqual([
      "me/private-repo",
      "me/public-repo",
    ]);
  });
});

describe("allBranches mode", () => {
  /**
   * Reproduces the real-world case: a commit pushed to a feature branch that
   * has not been merged into the default branch. Contribution data and the
   * default-branch history both miss it.
   */
  const featureOnlyHandlers = (): Handler[] => [
    viewerLogin,
    viewerId,
    {
      match: (q) => q.includes("contributionsCollection"),
      respond: () => ({
        data: {
          user: {
            contributionsCollection: { commitContributionsByRepository: [] },
          },
        },
      }),
    },
    {
      match: (q) => q.includes("affiliations"),
      respond: () => ({
        data: {
          viewer: {
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  nameWithOwner: "me/votepro-v2",
                  isArchived: false,
                  pushedAt: new Date(2026, 2, 15).toISOString(),
                },
              ],
            },
          },
        },
      }),
    },
    {
      match: (q) => q.includes('refPrefix: "refs/heads/"'),
      respond: () => ({
        data: {
          repository: {
            defaultBranchRef: { name: "main" },
            refs: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  name: "main",
                  target: { committedDate: new Date(2026, 2, 14).toISOString() },
                },
                {
                  name: "design",
                  target: { committedDate: new Date(2026, 2, 15).toISOString() },
                },
              ],
            },
          },
        },
      }),
    },
    {
      // Default branch has nothing from this author in range.
      match: (q) => q.includes("defaultBranchRef"),
      respond: () => ({
        data: {
          repository: {
            defaultBranchRef: {
              target: {
                history: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        },
      }),
    },
    {
      match: (q) => q.includes("ref(qualifiedName"),
      respond: (vars) => ({
        data: {
          repository: {
            ref: {
              target: {
                history: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes:
                    vars.branch === "design"
                      ? [
                          {
                            oid: "feat1",
                            committedDate: new Date(
                              2026,
                              2,
                              15,
                              15,
                              16,
                            ).toISOString(),
                            messageHeadline: "Add widget shell",
                            url: "#",
                          },
                        ]
                      : [],
                },
              },
            },
          },
        },
      }),
    },
  ];

  it("misses unmerged branch commits when disabled", async () => {
    mockGraphQL(featureOnlyHandlers());
    const commits = await fetchCommits("t", FROM, TO, undefined, false);
    expect(commits).toEqual([]);
  });

  it("finds unmerged branch commits when enabled", async () => {
    mockGraphQL(featureOnlyHandlers());
    const commits = await fetchCommits("t", FROM, TO, undefined, true);
    expect(commits.map((c) => c.oid)).toEqual(["feat1"]);
    expect(commits[0].repo).toBe("me/votepro-v2");
  });

  it("de-duplicates commits reachable from multiple branches", async () => {
    const shared = {
      oid: "shared1",
      committedDate: new Date(2026, 2, 12, 9, 0).toISOString(),
      messageHeadline: "shared",
      url: "#",
    };
    mockGraphQL([
      viewerLogin,
      viewerId,
      {
        match: (q) => q.includes("contributionsCollection"),
        respond: () => ({
          data: {
            user: {
              contributionsCollection: {
                commitContributionsByRepository: [
                  { repository: { nameWithOwner: "me/dup" } },
                ],
              },
            },
          },
        }),
      },
      {
        match: (q) => q.includes("affiliations"),
        respond: () => ({
          data: {
            viewer: {
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        }),
      },
      {
        match: (q) => q.includes('refPrefix: "refs/heads/"'),
        respond: () => ({
          data: {
            repository: {
              defaultBranchRef: { name: "main" },
              refs: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    name: "main",
                    target: {
                      committedDate: new Date(2026, 2, 12).toISOString(),
                    },
                  },
                  {
                    name: "topic",
                    target: {
                      committedDate: new Date(2026, 2, 12).toISOString(),
                    },
                  },
                ],
              },
            },
          },
        }),
      },
      {
        match: (q) => q.includes("defaultBranchRef"),
        respond: () => ({
          data: {
            repository: {
              defaultBranchRef: {
                target: {
                  history: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [shared],
                  },
                },
              },
            },
          },
        }),
      },
      {
        match: (q) => q.includes("ref(qualifiedName"),
        respond: () => ({
          data: {
            repository: {
              ref: {
                target: {
                  history: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [shared],
                  },
                },
              },
            },
          },
        }),
      },
    ]);

    const commits = await fetchCommits("t", FROM, TO, undefined, true);
    expect(commits).toHaveLength(1);
  });
});

describe("fetchRepoBranches", () => {
  const branchList = (
    nodes: { name: string; committedDate: string | null }[],
    defaultBranch = "main",
  ): Handler[] => [
    {
      match: (q) => q.includes('refPrefix: "refs/heads/"'),
      respond: () => ({
        data: {
          repository: {
            defaultBranchRef: { name: defaultBranch },
            refs: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: nodes.map((n) => ({
                name: n.name,
                target: n.committedDate
                  ? { committedDate: n.committedDate }
                  : null,
              })),
            },
          },
        },
      }),
    },
  ];

  it("skips branches whose tip predates the range", async () => {
    mockGraphQL(
      branchList([
        { name: "main", committedDate: new Date(2026, 2, 20).toISOString() },
        { name: "active", committedDate: new Date(2026, 2, 18).toISOString() },
        { name: "stale", committedDate: new Date(2024, 0, 1).toISOString() },
      ]),
    );
    // "main" is the default branch (scanned separately), "stale" is too old.
    expect(await fetchRepoBranches("t", "me/r", FROM)).toEqual(["active"]);
  });

  it("keeps branches with an unknown tip date", async () => {
    mockGraphQL(
      branchList([{ name: "weird", committedDate: null }]),
    );
    expect(await fetchRepoBranches("t", "me/r", FROM)).toEqual(["weird"]);
  });

  it("returns every non-default branch when no cutoff is given", async () => {
    mockGraphQL(
      branchList([
        { name: "main", committedDate: new Date(2026, 2, 20).toISOString() },
        { name: "stale", committedDate: new Date(2024, 0, 1).toISOString() },
      ]),
    );
    expect(await fetchRepoBranches("t", "me/r")).toEqual(["stale"]);
  });
});

describe("fetchAffiliatedRepos", () => {
  it("excludes archived repos and those pushed before the range", async () => {
    mockGraphQL([
      {
        match: (q) => q.includes("affiliations"),
        respond: () => ({
          data: {
            viewer: {
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    nameWithOwner: "me/fresh",
                    isArchived: false,
                    pushedAt: new Date(2026, 2, 20).toISOString(),
                  },
                  {
                    nameWithOwner: "me/archived",
                    isArchived: true,
                    pushedAt: new Date(2026, 2, 19).toISOString(),
                  },
                  {
                    nameWithOwner: "me/stale",
                    isArchived: false,
                    pushedAt: new Date(2025, 0, 1).toISOString(),
                  },
                ],
              },
            },
          },
        }),
      },
    ]);

    expect(await fetchAffiliatedRepos("t", FROM)).toEqual(["me/fresh"]);
  });
});
