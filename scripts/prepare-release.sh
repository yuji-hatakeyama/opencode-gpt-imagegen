#!/usr/bin/env bash
set -euo pipefail

LEVEL="${1:?usage: prepare-release.sh <patch|minor|major>}"

case "$LEVEL" in
  patch|minor|major) ;;
  *) echo "Error: level must be patch|minor|major (got: $LEVEL)" >&2; exit 1 ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is not clean (commit, stash, or .gitignore the changes first)" >&2
  git status --short >&2
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Error: must be on 'main' (currently on '$CURRENT_BRANCH')" >&2
  exit 1
fi

git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "Error: local 'main' is out of sync with 'origin/main' (pull or push first)" >&2
  exit 1
fi

PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
CURRENT=$(node -p "require('./package.json').version")
NEXT=$(node -p "
  const v = '$CURRENT'.split('.').map(Number);
  const m = { patch: [v[0], v[1], v[2]+1], minor: [v[0], v[1]+1, 0], major: [v[0]+1, 0, 0] };
  m['$LEVEL'].join('.')
")
HEAD_SHA=$(git rev-parse --short HEAD)
REMOTE_URL=$(git remote get-url origin)
REMOTE_URL="${REMOTE_URL%.git}"
case "$REMOTE_URL" in
  git@*:*)
    rest="${REMOTE_URL#git@}"
    REPO_URL="https://${rest/://}"
    ;;
  *)
    REPO_URL="$REMOTE_URL"
    ;;
esac

echo "============================================"
echo "  Release: v$CURRENT → v$NEXT  ($LEVEL)"
echo "============================================"
echo

if [ -z "$PREV_TAG" ]; then
  echo "(no previous tag found; skipping diff review)"
else
  echo "Commits ($PREV_TAG..HEAD):"
  git log --pretty=format:'  %h %s' "$PREV_TAG..HEAD"
  echo
  echo
  echo "Review:"
  echo "  $REPO_URL/compare/$PREV_TAG...$HEAD_SHA"
fi

echo
read -rp "Proceed with v$NEXT? (y/N) " REPLY
[[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }

npm version "$LEVEL" -m "chore: release %s"
