#!/usr/bin/env bash
set -Eeuo pipefail

provider=""
mode=""
results_path=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --provider)
      provider="${2:-}"
      shift 2
      ;;
    --mode)
      mode="${2:-}"
      shift 2
      ;;
    --results-path)
      results_path="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$provider" ] || [ -z "$mode" ]; then
  echo "usage: $0 --provider <owned|github> --mode <default|nix|full> [--results-path <path>]" >&2
  exit 2
fi

case "$provider" in
  owned)
    if [ "$mode" != "default" ]; then
      echo "owned only supports --mode default" >&2
      exit 2
    fi
    ;;
  github)
    if [ "$mode" != "nix" ] && [ "$mode" != "full" ]; then
      echo "github only supports --mode nix|full" >&2
      exit 2
    fi
    ;;
  *)
    echo "unknown provider: $provider" >&2
    exit 2
    ;;
esac

event_name="${GITHUB_EVENT_NAME:-unknown}"
head_sha="${CI_GATE_HEAD_SHA:-${GITHUB_SHA:-unknown}}"
run_id="${GITHUB_RUN_ID:-unknown}"
run_attempt="${GITHUB_RUN_ATTEMPT:-unknown}"

ci_root="${GITHUB_WORKSPACE:-$(pwd)}"
results_path="${results_path:-$ci_root/.tmp/workflows/ci-gate/runs/$run_id/ci-results.json}"
results_dir="$(dirname "$results_path")"
selection_path="$results_dir/selection.json"

export COREPACK_ENABLE_DOWNLOAD_PROMPT="${COREPACK_ENABLE_DOWNLOAD_PROMPT:-0}"
export COREPACK_HOME="${COREPACK_HOME:-$HOME/.cache/open-design-ci/corepack}"
export npm_config_store_dir="${npm_config_store_dir:-$HOME/.cache/open-design-ci/pnpm-store}"
export npm_config_fetch_retries="${npm_config_fetch_retries:-6}"
export npm_config_fetch_retry_maxtimeout="${npm_config_fetch_retry_maxtimeout:-120000}"
export npm_config_fetch_retry_mintimeout="${npm_config_fetch_retry_mintimeout:-20000}"
export npm_config_network_timeout="${npm_config_network_timeout:-180000}"

mkdir -p "$results_dir"
mkdir -p "$COREPACK_HOME"
mkdir -p "$npm_config_store_dir"

PROVIDER="$provider" \
MODE="$mode" \
MANIFEST_PATH="$ci_root/tools/ci/atoms.json" \
SELECTION_PATH="$selection_path" \
node <<'EOF'
const fs = require("node:fs");

const provider = process.env.PROVIDER;
const mode = process.env.MODE;
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST_PATH, "utf8"));

function isSelected(atom) {
  if (provider === "owned") return atom.name !== "nix";
  if (provider === "github" && mode === "nix") return atom.name === "nix";
  if (provider === "github" && mode === "full") return true;
  throw new Error(`unsupported provider/mode: ${provider}/${mode}`);
}

function unavailableFor(atom) {
  if (provider === "owned" && atom.name === "nix") {
    return {
      atom: atom.name,
      missingCapabilities: ["nix"],
      reason: "owned-nix-substrate-not-proven",
      status: "unavailable",
    };
  }
  return {
    atom: atom.name,
    missingCapabilities: [],
    reason: `${provider}-${mode}-not-selected`,
    status: "unavailable",
  };
}

const selectedAtoms = [];
const unavailable = [];
for (const atom of manifest.atoms) {
  if (isSelected(atom)) {
    selectedAtoms.push(atom.name);
  } else {
    unavailable.push(unavailableFor(atom));
  }
}

fs.writeFileSync(
  process.env.SELECTION_PATH,
  `${JSON.stringify({
    provider,
    schemaVersion: 1,
    selectedAtoms,
    unavailable,
  }, null, 2)}\n`,
);
EOF

export OD_CI_ARTIFACTS_DIR="$results_dir/artifacts"
export OD_CI_ATOM_MANIFEST="$ci_root/tools/ci/atoms.json"
export OD_CI_CACHE_DIR="${OD_CI_CACHE_DIR:-$HOME/.cache/open-design-ci/$provider-$mode}"
export OD_CI_EVENT_NAME="$event_name"
export OD_CI_HEAD_SHA="$head_sha"
export OD_CI_MODE="$mode"
export OD_CI_PROVIDER_ID="$provider"
export OD_CI_REPO_DIR="$ci_root"
export OD_CI_RESULTS_DIR="$results_dir"
export OD_CI_RUN_ATTEMPT="$run_attempt"
export OD_CI_RUN_ID="$run_id"
export OD_CI_TMP_DIR="${OD_CI_TMP_DIR:-${RUNNER_TEMP:-$ci_root/.tmp/tools-ci}/$provider-$mode-$run_id}"
export OD_CI_WORK_DIR="$ci_root"
export OD_CI_WORKSPACE_ROOT="$ci_root"

set +e
node "$ci_root/tools/ci/dist/index.mjs" execute \
  --manifest "$OD_CI_ATOM_MANIFEST" \
  --selection "$selection_path"
execute_exit="$?"
set -e

generated_results_path="$results_dir/ci-results.json"
if [ "$generated_results_path" != "$results_path" ] && [ -f "$generated_results_path" ]; then
  cp "$generated_results_path" "$results_path"
fi

echo "ci results: $results_path"
if [ -f "$results_path" ]; then
  echo "OD_CI_RESULTS_JSON $(base64 < "$results_path" | tr -d '\n')"
fi
exit "$execute_exit"
