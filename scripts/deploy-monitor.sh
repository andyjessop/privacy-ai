#!/bin/bash

# Configuration
REPO_DIR="${REPO_DIR:-/opt/privacy-ai}"
BRANCH="${BRANCH:-main}"
CHECK_INTERVAL="${CHECK_INTERVAL:-60}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

# Ensure we are in the repo directory
cd "$REPO_DIR" || { error "Directory $REPO_DIR not found"; exit 1; }

# Check for GITHUB_TOKEN
if [ -z "$GITHUB_TOKEN" ]; then
    warn "GITHUB_TOKEN not set. Skipping CI status checks (deploying any commit to $BRANCH)."
fi

log "Starting deployment monitor for branch: $BRANCH"

while true; do
    # Fetch latest revisions
    git fetch origin "$BRANCH" > /dev/null 2>&1

    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse "origin/$BRANCH")

    if [ "$LOCAL" != "$REMOTE" ]; then
        log "New commit detected: $REMOTE"

        SHOULD_DEPLOY=true

        # Optional: Check CI Status if token provided
        if [ -n "$GITHUB_TOKEN" ]; then
            # Extract owner/repo from remote url
            REPO_URL=$(git config --get remote.origin.url)
            # Handle SSH or HTTPS urls to get owner/repo
            # e.g. git@github.com:user/repo.git -> user/repo
            # e.g. https://github.com/user/repo.git -> user/repo
            REPO_SLUG=$(echo "$REPO_URL" | sed -E 's/.*github.com[:/](.*)(\.git)?/\1/' | sed 's/\.git$//')
            
            log "Checking CI status for $REPO_SLUG @ $REMOTE..."
            
            # Get combined status (checks)
            STATUS_JSON=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
                "https://api.github.com/repos/$REPO_SLUG/commits/$REMOTE/check-runs")
            
            # Simple check: verify if any check allows us to proceed? 
            # Actually, typically we check commit status or check-suites. 
            # For simplicity, let's use the 'commits/:ref/status' endpoint (classic) or just proceed if user trusts main.
            # Using 'commits/:ref/check-runs' gives detailed action runs.
            
            # Let's check 'conclusion' of the latest run for the workflow 'CI/CD' or generally if it's 'success'.
            # Parsing complex JSON in bash is brittle. 
            # A robust way is to check if there are any 'in_progress' or 'failure' states.
            
            FAILURES=$(echo "$STATUS_JSON" | grep -o '"conclusion": "[^"]*"' | grep -v 'success' | grep -v 'neutral' | grep -v 'skipped' || true)
            IN_PROGRESS=$(echo "$STATUS_JSON" | grep -o '"status": "[^"]*"' | grep -v 'completed' || true)

            if [ -n "$FAILURES" ]; then
                warn "CI has failures on latest commit. Skipping deploy."
                SHOULD_DEPLOY=false
            elif [ -n "$IN_PROGRESS" ]; then
                warn "CI is still in progress. Waiting..."
                SHOULD_DEPLOY=false
            else
                log "CI status appears green."
            fi
        fi

        if [ "$SHOULD_DEPLOY" = true ]; then
            log "Deploying update..."
            
            # Pull changes
            git pull origin "$BRANCH"
            
            # Reload env vars just in case .env changed (though docker compose reads file directly)
            # Rebuild and restart services
            docker compose up -d --build --remove-orphans
            
            log "Deployment complete."
        fi
    fi

    sleep "$CHECK_INTERVAL"
done
