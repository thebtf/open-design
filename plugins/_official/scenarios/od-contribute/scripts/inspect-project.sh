#!/usr/bin/env bash
# Read an Open Design project folder and emit structured JSON describing
# everything we can auto-derive for a plugin manifest. The plugin branch
# (Step 3e) consumes this so the user doesn't have to retype metadata
# they already produced inside Open Design.
#
# Usage:
#   inspect-project.sh <project-dir>   → JSON on stdout
#   inspect-project.sh --list          → one-line "<uuid>\t<title>\t<mtime>"
#                                        per recent project, ranked newest
#                                        first; agent shows this in an
#                                        AskUserQuestion picker.
#
# Project layout we look at (verified against ~/Library/Application
# Support/Open Design/namespaces/default/data/projects/<uuid>/):
#   - <name>.html.artifact.json   → title, kind, entry, identifier, exports
#   - brand-spec.md               → user's input brief (best surrogate for
#                                   "the original prompt" since OD's actual
#                                   chat lives in Electron IndexedDB)
#   - **/*.html, **/*.png, …      → asset bundle
#
# Things we deliberately do NOT extract (and why):
#   - the literal chat prompt: lives in IndexedDB / LevelDB; reading it
#     is brittle and would break the moment OD's Electron build changes.
#     brand-spec.md is the closest stable proxy.
#   - the active design system: not currently written into the project
#     folder; the agent has to ask the user (one short question).
#   - which atoms ran: not in the project either; we default the pipeline
#     to a sane shape per artifact kind, and the agent can show that to
#     the user and let them edit.

set -uo pipefail
source "$(dirname "$0")/config.sh"
set +e
set -uo pipefail

OD_PROJECTS_ROOT="${OD_PROJECTS_ROOT:-$HOME/Library/Application Support/Open Design/namespaces/default/data/projects}"

# --- list mode ----------------------------------------------------------------
if [[ "${1:-}" == "--list" ]]; then
  if [[ ! -d "$OD_PROJECTS_ROOT" ]]; then
    od::err "OD project root not found: $OD_PROJECTS_ROOT"
    exit 2
  fi
  # Emit one TSV row per project: uuid \t title \t mtime_iso
  for proj in "$OD_PROJECTS_ROOT"/*/; do
    [[ -d "$proj" ]] || continue
    uuid="$(basename "$proj")"
    # Title comes from any *.artifact.json in the project; fall back to a
    # human-shaped UUID if none exists (empty / fresh project).
    title=""
    while IFS= read -r artifact_json; do
      [[ -z "$artifact_json" ]] && continue
      t="$(jq -r '.title // empty' "$artifact_json" 2>/dev/null)"
      if [[ -n "$t" ]]; then title="$t"; break; fi
    done < <(find "$proj" -maxdepth 2 -name '*.artifact.json' -type f 2>/dev/null)
    [[ -z "$title" ]] && title="(untitled, $uuid)"
    mtime_epoch="$(stat -f %m "$proj" 2>/dev/null || stat -c %Y "$proj" 2>/dev/null)"
    mtime_iso="$(date -u -r "$mtime_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
                 || date -u -d "@$mtime_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
                 || echo "")"
    printf '%s\t%s\t%s\n' "$uuid" "$title" "$mtime_iso"
  done | sort -t$'\t' -k3,3r   # sort by mtime desc
  exit 0
fi

# --- inspect mode -------------------------------------------------------------
PROJECT_DIR="${1:?project directory required (or --list)}"

# Caller may pass a UUID instead of a full path — resolve.
if [[ ! -d "$PROJECT_DIR" && -d "$OD_PROJECTS_ROOT/$PROJECT_DIR" ]]; then
  PROJECT_DIR="$OD_PROJECTS_ROOT/$PROJECT_DIR"
fi
[[ -d "$PROJECT_DIR" ]] || od::die "not a directory: $PROJECT_DIR"
ABS_PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd -P)"

# Pick the artifact.json. Most projects have one; multi-artifact projects
# pick the one matching `index.html` if present, else the most recently
# modified.
ARTIFACT_JSON=""
if [[ -f "$ABS_PROJECT_DIR/index.html.artifact.json" ]]; then
  ARTIFACT_JSON="$ABS_PROJECT_DIR/index.html.artifact.json"
else
  ARTIFACT_JSON="$(find "$ABS_PROJECT_DIR" -maxdepth 2 -name '*.artifact.json' -type f \
                   -exec stat -f '%m %N' {} + 2>/dev/null \
                   | sort -rn | head -1 | awk '{ $1=""; print substr($0,2) }')"
fi

# Pull the easy fields (or empty strings if no artifact.json).
title=""
identifier=""
kind=""
entry=""
created_at=""
if [[ -n "$ARTIFACT_JSON" && -f "$ARTIFACT_JSON" ]]; then
  title="$(jq -r '.title // ""' "$ARTIFACT_JSON" 2>/dev/null)"
  identifier="$(jq -r '.metadata.identifier // ""' "$ARTIFACT_JSON" 2>/dev/null)"
  kind="$(jq -r '.kind // ""' "$ARTIFACT_JSON" 2>/dev/null)"
  entry="$(jq -r '.entry // ""' "$ARTIFACT_JSON" 2>/dev/null)"
  created_at="$(jq -r '.createdAt // ""' "$ARTIFACT_JSON" 2>/dev/null)"
fi

# Suggested plugin-id: normalize identifier to kebab-case; fall back to
# slug-of-title; else uuid prefix.
slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-48
}
suggested_plugin_id="$(slugify "$identifier")"
[[ -z "$suggested_plugin_id" ]] && suggested_plugin_id="$(slugify "$title")"
[[ -z "$suggested_plugin_id" ]] && suggested_plugin_id="$(basename "$ABS_PROJECT_DIR" | cut -c1-8)"

# Map artifact kind to plugin mode (per plugins/spec/CONTRIBUTING.md):
#   prototype, deck, live-artifact, image, video, hyperframes, audio, design-system
case "$kind" in
  html|jsx|web)        suggested_mode="live-artifact" ;;
  pdf|deck|slides)     suggested_mode="deck" ;;
  png|jpg|jpeg|image)  suggested_mode="image" ;;
  mp4|mov|video)       suggested_mode="video" ;;
  *)                   suggested_mode="prototype" ;;   # safe default
esac
suggested_lane="create"   # most user-built artifacts are "create" lane

# Brief: prefer brand-spec.md, fall back to README, else empty.
brief_path=""
brief_excerpt=""
for cand in brand-spec.md README.md; do
  if [[ -f "$ABS_PROJECT_DIR/$cand" ]]; then
    brief_path="$cand"
    # First non-blank prose line under any heading — gives a usable
    # one-paragraph summary without dragging the whole spec into the
    # manifest. Keep it ≤ 280 chars to fit a marketplace card.
    brief_excerpt="$(awk '
      BEGIN { found=0 }
      /^[[:space:]]*$/ { next }
      /^[[:space:]]*#/ { next }
      /^[[:space:]]*```/ { in_fence=!in_fence; next }
      in_fence { next }
      { print; found=1; exit }
    ' "$ABS_PROJECT_DIR/$cand" | head -c 280)"
    break
  fi
done

# Asset list: every regular file in the project, relative to project root.
# Skip OS / scratch noise (.DS_Store, *.artifact.json, …) — those are not
# part of the user's contribution surface.
assets_json="$(
  cd "$ABS_PROJECT_DIR" && find . -type f \
    ! -name '.DS_Store' \
    ! -name '*.artifact.json' \
    ! -path './data/*' 2>/dev/null \
    | sed 's|^\./||' \
    | sort \
    | jq -R -s '
        split("\n")
        | map(select(length > 0))
        | map({path: ., size: 0, kind: (split(".") | last | ascii_downcase)})
      '
)"

# Final shape — one JSON object on stdout.
jq -n \
  --arg uuid "$(basename "$ABS_PROJECT_DIR")" \
  --arg path "$ABS_PROJECT_DIR" \
  --arg title "$title" \
  --arg identifier "$identifier" \
  --arg kind "$kind" \
  --arg entry "$entry" \
  --arg created_at "$created_at" \
  --arg suggested_plugin_id "$suggested_plugin_id" \
  --arg suggested_mode "$suggested_mode" \
  --arg suggested_lane "$suggested_lane" \
  --arg brief_path "$brief_path" \
  --arg brief_excerpt "$brief_excerpt" \
  --argjson assets "$assets_json" \
  '{
    project: { uuid: $uuid, path: $path, title: $title, identifier: $identifier,
               kind: $kind, entry: $entry, createdAt: $created_at },
    suggested: { plugin_id: $suggested_plugin_id, mode: $suggested_mode, lane: $suggested_lane },
    brief: { path: $brief_path, excerpt: $brief_excerpt },
    assets: $assets,
    asset_count: ($assets | length),
    needs_user_input: [
      "design_system",
      "capabilities"
    ]
  }'
