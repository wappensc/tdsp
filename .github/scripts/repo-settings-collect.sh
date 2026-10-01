#!/usr/bin/env bash
# Asks GitHub, through the `gh` command line, for everything .github/repository-settings.json
# describes, and prints it as one JSON object: for each API path either {"ok":true,"data":…}
# or {"ok":false} when the token in use may not read it. Reading only; nothing is changed.
# tools/repo-settings.ts compares the result (docs/repository-settings.md).
#
# This script talks to api.github.com, which is why it lives with the workflows and not in
# tools/: the code in packages/, bridges/, tools/ and infra/ reaches loopback only
# (docs/network-policy.md).
set -euo pipefail

config="${1:-.github/repository-settings.json}"
repo=$(jq -r .repository "$config")
org=$(jq -r .organization "$config")
branch=$(jq -r .defaultBranch "$config")

paths=(
  "repos/$repo"
  "repos/$repo/rules/branches/$branch"
  "repos/$repo/collaborators?per_page=100"
  "repos/$repo/codeowners/errors"
  "repos/$repo/rulesets?targets=branch,tag"
  "repos/$repo/immutable-releases"
  "repos/$repo/teams?per_page=100"
  "repos/$repo/actions/permissions"
  "repos/$repo/actions/permissions/workflow"
  "repos/$repo/actions/permissions/fork-pr-contributor-approval"
  "orgs/$org/members?role=admin&per_page=100"
)
for team in $(jq -r '.teams | keys[]' "$config"); do
  paths+=("orgs/$org/teams/$team/members?per_page=100")
done

fetch() {
  local path="$1" out
  if out=$(gh api "$path" 2>/dev/null); then
    jq -n --arg path "$path" --argjson data "$out" '{($path): {ok: true, data: $data}}'
  else
    jq -n --arg path "$path" '{($path): {ok: false}}'
  fi
}

{
  for path in "${paths[@]}"; do
    fetch "$path"
  done
  # Each ruleset's details (its bypass list among them), for the ids the list returned. The
  # list names its targets: GitHub does not document which rulesets it returns without them.
  if ids=$(gh api "repos/$repo/rulesets?targets=branch,tag" --jq '.[].id' 2>/dev/null); then
    for id in $ids; do
      fetch "repos/$repo/rulesets/$id"
    done
  fi
} | jq -s --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{collectedAt: $at, endpoints: add}'
