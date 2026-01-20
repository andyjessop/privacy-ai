# Self-Hosted Deployment Setup

This guide explains how to set up the **Deployment Monitor** on your server (Debian/Ubuntu/LXC).

## What it does
- Polls GitHub every minute for new commits to `main`.
- (Optional) Checks if the CI (GitHub Actions) passed.
- Pulls the code and restarts Docker services.

## Prerequisites
- **Container Runtime**: Docker Engine 20.10+ & Docker Compose Plugin (v2.0+).
- **System Resources**:
  - Minimum: 2 CPU cores, 4GB RAM.
  - Recommended: 4 CPU cores, 8GB RAM (especially if using larger local models).
  - Storage: 20GB+ SSD space for images and database.
- **Git**: Installed on the host.
- **Network**: Outbound internet access to pull Docker images and git repo.
- **API Keys & Tokens**:
  - **Mistral API Key**: Required for the main application (`MISTRAL_API_KEY`). Get one from [Mistral AI Console](https://console.mistral.ai/).
  - **GitHub Token (Optional)**: Recommended for the deployment monitor to check CI status before deploying (`GITHUB_TOKEN`). Generate a [Personal Access Token (Classic)](https://github.com/settings/tokens) with `repo` scope.

> **Note on Docker**: Ensure Docker is running as a systemd service (`docker.service`).
> Check with: `systemctl status docker`
> If installed via Snap, the service might be named `snap.docker.dockerd.service`. You may need to edit `scripts/privacy-ai-deploy.service` to match your specific service name if it differs from `docker.service`.

## Setup Steps

### 1. Clone the Repo
SSH into your server and clone the repo:
```bash
git clone https://github.com/andyjessop/privacy-ai.git /opt/privacy-ai
cd /opt/privacy-ai
```

### 2. Configure Environment `.env`
Create the production `.env` file for the application:
```bash
cp .env.example .env
nano .env
```
Fill in your `MISTRAL_API_KEY`, `POSTGRES_PASSWORD`, etc.

### 3. Configure Monitor Secrets `.env.deploy` (Optional)
If you want the monitor to check CI status (Recommended), create a personal access token (Classic) on GitHub with `repo` scope.

Create a separate env file for the service:
```bash
sudo nano /opt/privacy-ai/.env.deploy
```
Add:
```env
GITHUB_TOKEN=ghp_your_token_here
REPO_DIR=/opt/privacy-ai
BRANCH=main
```

### 4. Install the Service
Copy the systemd unit and script:

```bash
# Make script executable
sudo chmod +x scripts/deploy-monitor.sh

# Link service file
sudo cp scripts/privacy-ai-deploy.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload
```

### 5. Start and Enable
```bash
sudo systemctl enable privacy-ai-deploy
sudo systemctl start privacy-ai-deploy
```

### 6. Verify
Check logs to see it working:
```bash
sudo journalctl -u privacy-ai-deploy -f
```
You should see: "Starting deployment monitor..." and "CI status appears green" (if configured).
