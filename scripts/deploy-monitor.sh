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
FIRST_RUN=true

while true; do
    # Ensure we are on the correct branch
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    if [ "$current_branch" != "$BRANCH" ]; then
        log "Switching from $current_branch to $BRANCH..."
        git checkout "$BRANCH" || { error "Failed to checkout $BRANCH"; exit 1; }
    fi

    # Fetch latest revisions
    git fetch origin "$BRANCH" > /dev/null 2>&1

    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse "origin/$BRANCH")

    # Deploy if there's a new commit OR if it's the first run (to ensure services are up)
    if [ "$LOCAL" != "$REMOTE" ] || [ "$FIRST_RUN" = true ]; then
        if [ "$FIRST_RUN" = true ]; then
             log "Initial run: Checking status for $REMOTE..."
        else
             log "New commit detected: $REMOTE"
        fi

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
            
            # Get combined status (check-runs)
            # Note: This checks the status of the commit that is presently on the remote (REMOTE hash)
            STATUS_JSON=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
                "https://api.github.com/repos/$REPO_SLUG/commits/$REMOTE/check-runs")
            
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
            
            # Capture script hash before update to detect self-change
            SCRIPT_HASH_BEFORE=$(git -C "$REPO_DIR" hash-object scripts/deploy-monitor.sh)

            # Reset hard to match origin (avoids divergent branch issues)
            if ! git reset --hard "origin/$BRANCH"; then
                error "Failed to reset to origin/$BRANCH."
                if [ "$FIRST_RUN" = true ]; then
                    FIRST_RUN=false
                fi
                sleep "$CHECK_INTERVAL"
                continue
            fi
            
            # Check if this script changed
            SCRIPT_HASH_AFTER=$(git -C "$REPO_DIR" hash-object scripts/deploy-monitor.sh)

            if [ "$SCRIPT_HASH_BEFORE" != "$SCRIPT_HASH_AFTER" ]; then
                 log "Self-update detected. Exiting to allow systemd to restart with new code."
                 exit 0
            fi
            
            # Reload env vars just in case .env changed (though docker compose reads file directly)
            # Rebuild and restart services
            docker compose up -d --build --remove-orphans
            
            log "Deployment complete."
        fi
        
        FIRST_RUN=false
    fi

    sleep "$CHECK_INTERVAL"
done
