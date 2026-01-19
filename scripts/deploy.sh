#!/bin/bash
set -e

# Configuration
REMOTE_USER="root"
REMOTE_HOST="proxmox-container-ip" # User needs to replace this
REMOTE_DIR="/opt/ai-api"
IMAGE_ARCHIVE="images.tar.gz"

echo "Building Docker images..."
docker build -f apps/api/Dockerfile -t api:latest .
docker build -f apps/vector/Dockerfile -t vector:latest .

echo "Saving images to archive..."
docker save api:latest vector:latest | gzip > $IMAGE_ARCHIVE

echo "Transferring files to remote server..."
# Ensure remote directory exists
ssh $REMOTE_USER@$REMOTE_HOST "mkdir -p $REMOTE_DIR"
scp $IMAGE_ARCHIVE docker-compose.yml $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/

echo "Deploying on remote server..."
ssh $REMOTE_USER@$REMOTE_HOST << EOF
  cd $REMOTE_DIR
  echo "Loading images..."
  docker load < $IMAGE_ARCHIVE
  echo "Starting services..."
  docker-compose up -d --remove-orphans
  rm $IMAGE_ARCHIVE
EOF

echo "Deployment complete!"
rm $IMAGE_ARCHIVE
