#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  setup-hapi-cli-linux.sh --api-url <url> [--token <token>] [--hapi-home <dir>]

Writes/updates:
  ~/.hapi/settings.json  (or $HAPI_HOME / --hapi-home)

Only updates:
  - apiUrl
  - cliApiToken (if provided)
EOF
}

api_url=""
token=""
hapi_home="${HAPI_HOME:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      api_url="${2:-}"; shift 2;;
    --token)
      token="${2:-}"; shift 2;;
    --hapi-home)
      hapi_home="${2:-}"; shift 2;;
    -h|--help)
      usage; exit 0;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2;;
  esac
done

if [[ -z "$api_url" ]]; then
  echo "Missing required --api-url" >&2
  usage
  exit 2
fi

if [[ -z "$hapi_home" ]]; then
  hapi_home="$HOME/.hapi"
fi

settings_file="$hapi_home/settings.json"
mkdir -p "$hapi_home"

python_bin=""
if command -v python3 >/dev/null 2>&1; then
  python_bin="python3"
elif command -v python >/dev/null 2>&1; then
  python_bin="python"
fi

if [[ -z "$python_bin" ]]; then
  echo "python3 not found; please install Python 3 or edit $settings_file manually." >&2
  exit 1
fi

if [[ -f "$settings_file" ]]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  cp -f "$settings_file" "$settings_file.bak.$ts" 2>/dev/null || true
fi

"$python_bin" - "$settings_file" "$api_url" "$token" <<'PY'
import json
import os
import sys

path, api_url, token = sys.argv[1], sys.argv[2], sys.argv[3]

data = {}
if os.path.exists(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        if raw:
            data = json.loads(raw) or {}
    except Exception:
        data = {}

data["apiUrl"] = api_url
if token.strip():
    data["cliApiToken"] = token.strip()

tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY

chmod 600 "$settings_file" 2>/dev/null || true
echo "Wrote: $settings_file"

