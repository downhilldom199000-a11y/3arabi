#!/usr/bin/env bash
#
# publish.sh — regenerate dist/ + repo.json with the correct absolute GitHub
# raw URLs, ready to commit & push.
#
# Usage:
#   ./publish.sh <github-user>/<github-repo> [<branch>]
#
# Example:
#   ./publish.sh myuser/skystream-arabi main
#
# After running this, commit + push:
#   git add repo.json dist/plugins.json dist/*.sky
#   git commit -m "publish 4 providers"
#   git push
#
# Then verify (after GitHub has the files):
#   curl -fsSL "https://raw.githubusercontent.com/<user>/<repo>/<branch>/repo.json"
#
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <github-user>/<github-repo> [<branch>]"
  echo "Example: $0 myuser/skystream-arabi main"
  exit 1
fi

REPO="$1"
BRANCH="${2:-main}"
BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

echo "=== Publishing sky-3arabi ==="
echo "  GitHub repo:   $REPO"
echo "  Branch:        $BRANCH"
echo "  Raw base URL:  $BASE"
echo ""

# Regenerate dist/ + repo.json with absolute URLs.
SKYSTREAM_REPO_URL="$BASE" node build/build.js

echo ""
echo "=== Done. Files to commit & push: ==="
echo "  repo.json"
echo "  dist/plugins.json"
echo "  dist/*.sky (4 files)"
echo ""
echo "Next steps:"
echo "  1. git add repo.json dist/"
echo "  2. git commit -m 'publish 4 providers'"
echo "  3. git push"
echo "  4. After GitHub shows the files, verify:"
echo "     curl -fsSL \"$BASE/repo.json\""
echo "  5. Paste this URL into SkyStream → Extensions → Add Repository:"
echo "     $BASE/repo.json"
