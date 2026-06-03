#!/usr/bin/env bash
# OD Contribute installer — self-bootstrapping.
# Fetches the latest od-contribute scenario from nexu-io/open-design and
# installs it into every supported AI agent's home directory.
#
# This installer exists for the SECONDARY distribution channel: users on
# standalone Claude Code / Codex / Cursor that aren't running through the
# Open Design app. Users on OD already have the plugin pre-bundled at
# plugins/_official/scenarios/od-contribute/ and don't need this script.
#
# Two ways to run this:
#
# 1) Tell your AI agent (Claude Code / Codex / Cursor / etc.) in the chat:
#
#      curl -sSL https://raw.githubusercontent.com/nexu-io/open-design/main/plugins/_official/scenarios/od-contribute/install.sh | bash
#
#    The agent's Bash tool runs this. You never open a terminal yourself.
#
# 2) Or paste that same one-liner into a terminal directly, if you prefer.
#
# Targets installed:
#   ~/.claude/skills/od-contribute/        Claude Code (native skill format)
#   ~/.claude/commands/od-contribute.md    Claude Code slash command (synthesized below)
#   ~/.agents/skills/od-contribute/        Codex CLI (canonical path)
#   ~/.codex/skills/od-contribute/         Codex CLI (legacy, only if ~/.codex exists)
#
# Override the source branch with OD_CONTRIBUTE_BRANCH=feat/foo (default: main).

set -euo pipefail

REPO="nexu-io/open-design"
BRANCH="${OD_CONTRIBUTE_BRANCH:-main}"

cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
gray()  { printf '\033[90m%s\033[0m\n' "$*"; }
die()   { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

cyan "Installing OD Contribute skill from ${REPO}@${BRANCH}..."

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v tar  >/dev/null 2>&1 || die "tar is required."

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Tarball download — no `git clone` needed (works in env without git).
TARBALL="$TMPDIR/repo.tar.gz"
curl -fsSL "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz" -o "$TARBALL" \
  || die "failed to fetch ${REPO}@${BRANCH} (branch may not exist)"

# Extract just the scenario folder we need. GitHub tarballs name the root
# dir <repo>-<branch>/, with slashes in branch names converted to dashes.
# The Claude Code slash command shim is synthesized below — no longer
# kept as a separate file in the OD repo.
TARBALL_ROOT="open-design-${BRANCH//\//-}"
tar -xzf "$TARBALL" -C "$TMPDIR" \
  "${TARBALL_ROOT}/plugins/_official/scenarios/od-contribute" \
  2>/dev/null || die "skill files not found in tarball — branch may have different layout"

SKILL_SRC="$TMPDIR/${TARBALL_ROOT}/plugins/_official/scenarios/od-contribute"
[[ -f "$SKILL_SRC/SKILL.md" ]] || die "SKILL.md missing at expected path"

install_skill_to() {
  local dest="$1" label="$2"

  # Preserve user-local state across reinstall/upgrade. Re-running this script
  # is the documented upgrade path ("re-run to pull the latest skill from
  # main"), so anything the user wrote here that ISN'T part of the skill
  # itself must survive `rm -rf`. Today that's just `.gh-token` (sandboxed
  # agents like Codex.app / Cursor write a GitHub token here when they can't
  # reach the macOS keychain — see check-prereqs.sh's hint and config.sh's
  # fallback). Add new state filenames to PRESERVE if we ever introduce more.
  local PRESERVE=(.gh-token)
  local stash=""
  local f
  for f in "${PRESERVE[@]}"; do
    if [[ -f "$dest/$f" ]]; then
      [[ -z "$stash" ]] && stash="$(mktemp -d)"
      cp -p "$dest/$f" "$stash/$f"
    fi
  done

  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$SKILL_SRC/." "$dest/"

  # Restore preserved state. The mode preservation (`cp -p` above + this
  # explicit chmod) keeps tokens at 600.
  if [[ -n "$stash" ]]; then
    for f in "${PRESERVE[@]}"; do
      if [[ -f "$stash/$f" ]]; then
        cp -p "$stash/$f" "$dest/$f"
        chmod 600 "$dest/$f" 2>/dev/null || true
      fi
    done
    rm -rf "$stash"
  fi

  # Ensure scripts retain executable bit (tar usually preserves; defense in depth).
  find "$dest" -name '*.sh' -exec chmod +x {} + 2>/dev/null || true
  green "  ✓ $label"
  gray  "      $dest"
}

# --- Claude Code (native, always install) -----------------------------------
install_skill_to "$HOME/.claude/skills/od-contribute" "Claude Code skill"

# Synthesize the slash command shim so the user can just type /od-contribute.
# We embed it inline (rather than a separate file in the OD repo) because the
# shim's only job is to load the skill — its content rarely needs maintenance,
# and one less repo file means one less place for the OD repo to surface a
# Claude-Code-specific artifact.
mkdir -p "$HOME/.claude/commands"
cat > "$HOME/.claude/commands/od-contribute.md" <<'EOF'
---
description: Open a first-contribution PR (or bug issue) on nexu-io/open-design — works for non-coders too.
argument-hint: "[skill | design-system | i18n | docs | bug | plugin — optional]"
---

You are entering the **od-contribute** flow.

User input (may be empty): `$ARGUMENTS`

## What to do right now

1. Load the `od-contribute` skill via the Skill tool. The skill owns the full execution playbook — do not reimplement it inline.

2. Pass the user input forward:
   - If `$ARGUMENTS` matches `skill`, `design-system`, `i18n`, `docs`, `bug`, or `plugin` (or a recognizable equivalent in any language), pre-select that branch and skip the type-picking question.
   - Otherwise, the skill will ask the user via `AskUserQuestion`.

3. Honor the interactive contract:
   - Run the prerequisite check first. If it fails, surface the install/auth hint verbatim and stop.
   - Show the preview and require explicit confirmation before pushing or opening any PR/issue.
   - Print the PR or issue URL on its own line at the end.

Begin by invoking the skill now.
EOF
green "  ✓ Claude Code slash command (/od-contribute)"
gray  "      $HOME/.claude/commands/od-contribute.md"

# --- Codex CLI (canonical) --------------------------------------------------
install_skill_to "$HOME/.agents/skills/od-contribute" "Codex CLI skill (~/.agents/skills/)"

# --- Codex CLI (legacy) — only if user already has Codex --------------------
if [[ -d "$HOME/.codex" ]]; then
  install_skill_to "$HOME/.codex/skills/od-contribute" "Codex CLI skill (legacy ~/.codex/skills/)"
fi

echo
green "Done."
echo
cyan "How to use it:"
cat <<'EOF'

  In Claude Code:  type  /od-contribute  in any chat.
  In Codex CLI:    type  @od-contribute  or pick "Open Design — Contribute" from /skills.
  In other agents: ask the agent to follow ~/.claude/skills/od-contribute/SKILL.md

The skill walks you through one of:

  * shipping a Skill or Design System you made with Open Design
  * translating a doc to a new language
  * fixing a typo or writing a use-case blog
  * reporting a clean bug

Need help? Open Design Discord:  https://discord.gg/qhbcCH8Am4
EOF
