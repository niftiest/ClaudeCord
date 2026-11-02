/** Whether the GitHub CLI can be used: `missing` not installed, `signed_out` needs `gh auth login`. */
export type GithubStatus = { state: 'missing' | 'signed_out' | 'ready'; account: string | null }

export type GithubRepo = {
  fullName: string
  description: string | null
  isPrivate: boolean
  isArchived: boolean
  pushedAt: string | null
}

/** A repo with no project yet, and the folder a new chat would clone it into. */
export type GithubRepoOption = GithubRepo & { destination: string }

export type GithubRepoList = { ok: true; repos: GithubRepoOption[] } | { ok: false; error: string }

export type PrepareRepoOutcome =
  | { ok: true; action: 'cloned' | 'pulled' | 'kept'; warning?: string }
  | { ok: false; error: string }
