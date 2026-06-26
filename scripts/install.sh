#!/usr/bin/env bash
# HubJupyLab systemd install script
# Run as root: sudo bash scripts/install.sh
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="hubjupylab"
SERVICE_USER="hubjupylab"
SERVICE_FILE="$INSTALL_DIR/hubjupylab.service"
ENV_FILE="$INSTALL_DIR/.env"

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: Run as root (sudo bash scripts/install.sh)" >&2
  exit 1
fi

# 1. Ensure .env exists
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Copy env.template to .env and configure it first." >&2
  exit 1
fi

# 2. Copy service file
echo "Installing $SERVICE_NAME.service ..."
cp "$SERVICE_FILE" /etc/systemd/system/

# 3. Fix ownership
echo "Setting ownership to $SERVICE_USER:$SERVICE_USER ..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
# DB files may be at parent level
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/../${SERVICE_NAME}.db"* 2>/dev/null || true

# 4. Enable systemd linger so tmux sessions survive service restarts
echo "Enabling linger for $SERVICE_USER ..."
loginctl enable-linger "$SERVICE_USER"

# 5. Reload systemd and enable + start service
echo "Reloading systemd daemon ..."
systemctl daemon-reload

echo "Enabling and starting $SERVICE_NAME ..."
systemctl enable --now "$SERVICE_NAME"

echo ""
echo "Done. Check status:"
echo "  sudo systemctl status $SERVICE_NAME"
echo "  sudo journalctl -u $SERVICE_NAME -f"
