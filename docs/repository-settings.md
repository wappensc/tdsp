# Repository settings

The development process ([CONTRIBUTING.md](../CONTRIBUTING.md), "Roles") rests on settings
that live on GitHub, not in the repository: which account may do what, and what `main`
accepts. If one of them changes, the CI role's ownership of the checks can be sidestepped
without any file changing — so they are written down here, recorded machine-readably in
[.github/repository-settings.json](../.github/repository-settings.json), and checked.

## What must be configured, and why

**Organization `wappensc`**

| Setting | Value | Otherwise |
| --- | --- | --- |
| Owners | `wappensc-admin` only | an owner can change every setting below |
| Team `admins` | member `wappensc-admin` | — |
| Team `ci` | member `wappensc-ci` | a developer in `ci` could approve their own changes to the checks |
| Team `developers` | member `wappensc-developer` | — |
| Teams' visibility | visible (not secret) | CODEOWNERS cannot name a secret team |

**Repository `wappensc/tdsp` → Settings → Collaborators and teams**

| Who | Role | Otherwise |
| --- | --- | --- |
| team `admins` | Admin | — |
| team `ci` | Write | without write access, `@wappensc/ci` is no valid code owner and CODEOWNERS binds nobody |
| team `developers` | Write | with Admin or Maintain, a developer could change or switch off the ruleset |
| no one else | — | every other account with write access is a way around the teams |

**Repository → Settings → Rules → Rulesets → `main`**

| Setting | Value | Otherwise |
| --- | --- | --- |
| Enforcement | Active | "Evaluate" only reports, and enforces nothing |
| Target | the default branch | — |
| Bypass list | teams `admins` and `ci`, "Always" | anyone else on it merges without checks or approval |
| Restrict deletions | on | `main` could be deleted and recreated |
| Block force pushes | on | history could be rewritten past the checks |
| Require a pull request | on, 0 required approvals | direct pushes would skip the checks |
| Require review from Code Owners | on | a change to the checks would need no CI approval |
| Dismiss stale approvals when new commits are pushed | on | a change could be swapped after the CI role approved it |
| Require status checks | `ci`, `matrix`, `email`, `network-isolation`, each from **GitHub Actions**; "up to date" off | a status set by hand through the API — which anyone with write access can do — would count |

**Repository → Settings → General**

| Setting | Value |
| --- | --- |
| Pull requests | enabled |
| Allow merge commits / rebase merging | off |
| Allow squash merging | on |
| Allow auto-merge | on |
| Automatically delete head branches | on |

**Repository → Settings → Actions → General**

| Setting | Value | Otherwise |
| --- | --- | --- |
| Actions | enabled | no check would run at all |
| Workflow permissions | read repository contents | a workflow could push, or change what it checks |
| Allow GitHub Actions to create and approve pull requests | off | a workflow could approve a change to the checks |
| Approval for running fork pull request workflows | all external contributors | a pull request from outside could run a modified workflow |

The team ids in `.github/repository-settings.json` are GitHub's: the ruleset's bypass list
names teams by id. A team deleted and created again under the same name gets a new id.

## How it is checked

`.github/scripts/repo-settings-collect.sh` asks GitHub (with `gh api`, reading only) for
everything above; `tools/repo-settings.ts` compares the answer with
`.github/repository-settings.json` and prints one line per check — ✓ passed, ✗ differs,
⚠ could not be read with the token in use. It never counts something it could not read as
passed.

**Automatically**, the workflow [Repository settings](../.github/workflows/repository-settings.yml)
runs on every push to `main`, every day at 05:17 UTC, and on demand (Actions → Repository
settings → Run workflow). It uses the workflow's own token, which cannot read the team
permissions, the ruleset's bypass list, or the Actions settings. Those checks end as a
warning — "not every check could be made" — and the job still passes; a setting it *can*
read that differs fails the job.

**By hand, in full**, the admin or the CI role runs every check. Anything that cannot be
read then fails:

1. Have `gh`, `jq`, `bash` and Node.js 22.6 or later, and a current checkout of
   `wappensc/tdsp`: the expected values come from its `.github/repository-settings.json`.

   ```sh
   cd ~/Projects/together-tdsp     # your clone of wappensc/tdsp
   git switch main && git pull
   ```

2. Sign in with an account that may read the repository's administration:

   - **as `wappensc-admin`** — `gh auth login` (or, with several accounts,
     `gh auth switch --user wappensc-admin`);
   - **as `wappensc-ci`** — its own account has write access only and cannot read the
     settings above. `wappensc-admin` issues it a fine-grained personal access token:
     GitHub → Settings → Developer settings → Fine-grained tokens, resource owner
     `wappensc`, repository `wappensc/tdsp`, repository permissions *Administration:
     read-only*, organization permissions *Members: read-only*, a short expiry. Use it for
     this one command:

     ```sh
     GH_TOKEN=<the token> pnpm run repo:settings
     ```

3. Run the full check:

   ```sh
   pnpm run repo:settings
   ```

   It ends with `repo-settings: every check passed.` and exit status 0, or names every
   check that differs or could not be made and exits 1. A check reported as not made
   names what it could not read — that is a missing permission of the token, not a pass.

Run it after any change to the organization, the teams or the repository's settings, and
from time to time besides the daily partial check.

## When a check fails

Set the repository back to the table above; the failing line names the setting and what it
is instead. If the change was intended — a new team member, a new required job — change
`.github/repository-settings.json` and this document in a pull request; the file belongs
to the CI role, so the change needs its approval like any other change to the checks.
