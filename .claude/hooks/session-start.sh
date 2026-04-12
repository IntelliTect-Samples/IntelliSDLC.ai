#!/bin/bash
set -euo pipefail

# Only run in remote (cloud) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Configure apt to use the egress proxy when available
if [ -n "${GLOBAL_AGENT_HTTP_PROXY:-}" ]; then
  echo "Acquire::http::Proxy \"${GLOBAL_AGENT_HTTP_PROXY}\";" | sudo tee /etc/apt/apt.conf.d/90proxy > /dev/null
  echo "Acquire::https::Proxy \"${GLOBAL_AGENT_HTTP_PROXY}\";" | sudo tee -a /etc/apt/apt.conf.d/90proxy > /dev/null
fi

# Install .NET 10 SDK if not already available
if ! command -v dotnet &>/dev/null || ! dotnet --list-sdks 2>/dev/null | grep -q '^10\.'; then
  echo "Installing .NET 10 SDK..." >&2
  sudo apt-get update -qq 2>/dev/null || true
  sudo apt-get install -y -qq dotnet-sdk-10.0
fi

# Restore NuGet packages
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"
SLN=$(find . -maxdepth 1 -name '*.sln' -o -name '*.slnx' | head -1)
if [ -n "$SLN" ]; then
  echo "Restoring NuGet packages for $SLN..." >&2
  dotnet restore "$SLN" --verbosity quiet
fi

# Export dotnet settings
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export DOTNET_CLI_TELEMETRY_OPTOUT=1' >> "$CLAUDE_ENV_FILE"
fi
