#!/bin/bash
# Deploy Doing It For a Cause website to GoDaddy via FTP.
# Run with: bash deploy.sh        — uploads all files
# Run with: bash deploy.sh html   — uploads only .html files (faster)
# Run with: bash deploy.sh data   — uploads only data.json (after mark-claimed / refresh-wishlist)

LOCAL_DIR="/Users/jordantomacelli/Desktop/Doing-It-For-A-Cause-Website"
REMOTE_ROOT="public_html"

if [ -z "$FTP_HOST" ] || [ -z "$FTP_USER" ] || [ -z "$FTP_PASS" ]; then
  echo "ERROR: FTP_HOST, FTP_USER, and FTP_PASS must be set."
  exit 1
fi

MODE="${1:-all}"

echo "Deploying to ftp://$FTP_HOST/$REMOTE_ROOT ..."

upload() {
  local file="$1"
  local relative="${file#$LOCAL_DIR/}"
  local remote_path="ftp://$FTP_HOST/$REMOTE_ROOT/$relative"
  echo "  Uploading: $relative"
  curl -s --ftp-create-dirs -T "$file" "$remote_path" \
    --user "$FTP_USER:$FTP_PASS" || echo "  FAILED: $relative"
}

if [ "$MODE" = "html" ]; then
  find "$LOCAL_DIR" -name "*.html" ! -path "*/node_modules/*" ! -path "*/.git/*" | sort | while read -r f; do
    upload "$f"
  done
elif [ "$MODE" = "data" ]; then
  upload "$LOCAL_DIR/run-for-a-cause/data.json"
else
  find "$LOCAL_DIR" -type f ! -name "deploy.sh" ! -name ".DS_Store" ! -path "*/node_modules/*" ! -path "*/.git/*" | sort | while read -r f; do
    upload "$f"
  done
fi

echo "Done."
