#!/usr/bin/env bash
# Refresh prod (our Azure VM deploy branch) on top of the latest upstream
# Menci/Floway main.
#
# Remote layout:
#   origin    = github.com/june9593/Floway  (our fork; we push here)
#   upstream  = github.com/Menci/copilot-gateway  (renamed to Floway upstream)
#
# Branch layout:
#   main      = mirror of upstream/main; pushed to origin/main as-is.
#   prod      = main + our deployment/ops scripts. Deploy from here.
#
# Run from repo root: ./scripts/pull-and-rebase.sh
set -euo pipefail

current=$(git symbolic-ref --short HEAD)

echo "==> Fetching upstream + origin"
git fetch upstream main
git fetch origin

echo "==> Fast-forwarding main to upstream/main"
git checkout main
git merge --ff-only upstream/main
git push origin main

echo "==> Rebasing prod onto main"
git checkout prod
git rebase main
git push --force-with-lease origin prod

# Return to the branch the user started on.
git checkout "$current"

echo
echo "✔ prod now sits on top of $(git rev-parse --short main)."
echo "Next: ./scripts/deploy-node-vm.sh --no-pull"
