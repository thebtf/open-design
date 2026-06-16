#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck disable=SC1091
source "$(dirname "$0")/../lib.sh"
# shellcheck disable=SC1091
source "$(dirname "$0")/browser-common.sh"

ci_gate_browser_prepare_env
ci_gate_browser_install_if_needed
ci_gate_browser_build_prereqs
ci_gate_browser_run_playwright_critical
