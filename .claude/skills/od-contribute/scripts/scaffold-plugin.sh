#!/usr/bin/env bash
# Scaffold a plugin folder under <workdir>/plugins/community/<plugin-id>/
# from the four templates already shipped in plugins/spec/templates/.
#
# Usage:
#   scaffold-plugin.sh \
#     --workdir <abs path to OD checkout> \
#     --plugin-id <kebab-case slug> \
#     --title "<Plugin Title>" \
#     --lane <create|import|export|share|deploy|refine|extend> \
#     --mode <prototype|deck|live-artifact|image|video|hyperframes|audio|design-system> \
#     --description "<one-sentence marketplace description>" \
#     [--author-name "<name>"]            (default: "Open Design Community")
#     [--target spec-examples|community]  (default: community)
#
# On success, prints:
#   TARGET_DIR=<abs path to scaffolded plugin folder>
#   SKILL_PATH=<abs path to SKILL.md>
#   MANIFEST_PATH=<abs path to open-design.json>
#
# Why we copy templates from the workdir rather than ship them in the skill:
#   The OD repo at plugins/spec/templates/ is the canonical source of truth.
#   The team maintains them bilingually and reviewers expect any new plugin
#   to look like its sibling examples. Pulling at scaffold time means we
#   stay current without us needing to mirror template changes.

set -euo pipefail
source "$(dirname "$0")/config.sh"

WORKDIR=""
PLUGIN_ID=""
TITLE=""
LANE=""
MODE=""
DESCRIPTION=""
AUTHOR_NAME="Open Design Community"
TARGET_KIND="community"
FROM_PROJECT=""        # path to OD project dir; when set, fields auto-derived
DESIGN_SYSTEM=""       # optional; only used in --from-project mode
PROJECT_ASSETS_ROOT="" # internal; resolved from $FROM_PROJECT for the copy step

while (($#)); do
  case "$1" in
    --workdir)        WORKDIR="$2"; shift 2 ;;
    --plugin-id)      PLUGIN_ID="$2"; shift 2 ;;
    --title)          TITLE="$2"; shift 2 ;;
    --lane)           LANE="$2"; shift 2 ;;
    --mode)           MODE="$2"; shift 2 ;;
    --description)    DESCRIPTION="$2"; shift 2 ;;
    --author-name)    AUTHOR_NAME="$2"; shift 2 ;;
    --target)         TARGET_KIND="$2"; shift 2 ;;
    --from-project)   FROM_PROJECT="$2"; shift 2 ;;
    --design-system)  DESIGN_SYSTEM="$2"; shift 2 ;;
    *) od::die "unknown flag: $1" ;;
  esac
done

# --from-project mode: run inspect-project.sh against the OD project folder
# and use its output to fill in any field the caller didn't override.
# Explicit flags from the caller still win (so the agent can let the user
# tweak any auto-derived value before scaffolding).
if [[ -n "$FROM_PROJECT" ]]; then
  [[ -d "$FROM_PROJECT" ]] || od::die "--from-project: not a directory: $FROM_PROJECT"
  od::require jq

  INSPECT_JSON="$(bash "$(dirname "$0")/inspect-project.sh" "$FROM_PROJECT")" \
    || od::die "inspect-project.sh failed; can't auto-derive fields"

  PROJECT_ASSETS_ROOT="$(printf '%s' "$INSPECT_JSON" | jq -r '.project.path')"

  # Fill defaults from inspection. Only when the flag wasn't explicit.
  [[ -z "$PLUGIN_ID"   ]] && PLUGIN_ID="$(printf '%s' "$INSPECT_JSON"   | jq -r '.suggested.plugin_id')"
  [[ -z "$TITLE"       ]] && TITLE="$(printf '%s' "$INSPECT_JSON"       | jq -r '.project.title // .suggested.plugin_id')"
  [[ -z "$LANE"        ]] && LANE="$(printf '%s' "$INSPECT_JSON"        | jq -r '.suggested.lane')"
  [[ -z "$MODE"        ]] && MODE="$(printf '%s' "$INSPECT_JSON"        | jq -r '.suggested.mode')"
  [[ -z "$DESCRIPTION" ]] && DESCRIPTION="$(printf '%s' "$INSPECT_JSON" | jq -r '.brief.excerpt // ""')"

  # If brief.excerpt was empty (no brand-spec.md / README.md), the
  # description ends up empty — that's still a fail downstream. Synthesize a
  # placeholder the agent can replace before push.
  [[ -z "$DESCRIPTION" ]] && DESCRIPTION="A plugin built in Open Design — please fill in a one-sentence description."
fi

[[ -n "$WORKDIR"     ]] || od::die "--workdir required"
[[ -n "$PLUGIN_ID"   ]] || od::die "--plugin-id required"
[[ -n "$TITLE"       ]] || od::die "--title required"
[[ -n "$LANE"        ]] || od::die "--lane required"
[[ -n "$MODE"        ]] || od::die "--mode required"
[[ -n "$DESCRIPTION" ]] || od::die "--description required"
[[ -d "$WORKDIR/.git" ]] || od::die "not a git workdir: $WORKDIR"

# Validate plugin-id shape: kebab-case, ASCII, no leading/trailing dash
if ! printf '%s' "$PLUGIN_ID" | grep -qE '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'; then
  od::die "plugin-id must be kebab-case ASCII (got: $PLUGIN_ID)"
fi

# Validate lane / mode against the spec's enums.
case "$LANE" in
  create|import|export|share|deploy|refine|extend) ;;
  *) od::die "lane must be one of: create / import / export / share / deploy / refine / extend (got: $LANE)" ;;
esac
case "$MODE" in
  prototype|deck|live-artifact|image|video|hyperframes|audio|design-system) ;;
  *) od::die "mode must be one of: prototype / deck / live-artifact / image / video / hyperframes / audio / design-system (got: $MODE)" ;;
esac

# Pick the target subtree.
case "$TARGET_KIND" in
  community)     PLUGIN_PARENT="$WORKDIR/plugins/community" ;;
  spec-examples) PLUGIN_PARENT="$WORKDIR/plugins/spec/examples" ;;
  *) od::die "--target must be community or spec-examples (got: $TARGET_KIND)" ;;
esac

TARGET_DIR="$PLUGIN_PARENT/$PLUGIN_ID"

# Refuse to scaffold over an existing folder — caller picks a new id.
if [[ -e "$TARGET_DIR" ]]; then
  od::die "target already exists: $TARGET_DIR (pick a different --plugin-id)"
fi

# Templates must exist in the workdir (they're bundled in OD's repo at
# plugins/spec/templates/). If they don't, the user's clone is stale.
TEMPLATES="$WORKDIR/plugins/spec/templates"
for required in SKILL.template.md open-design.template.json README.template.md; do
  [[ -f "$TEMPLATES/$required" ]] || od::die "template missing in checkout: plugins/spec/templates/$required (is the workdir up to date?)"
done

mkdir -p "$TARGET_DIR/assets" "$TARGET_DIR/preview"

# ----- SKILL.md -----
# Substitute frontmatter fields. The template uses placeholder values
# (name: plugin-id, version: "0.1.0", etc.) — replace with real values.
sed \
  -e "s|^name: .*|name: ${PLUGIN_ID}|" \
  -e "s|^description: .*|description: ${DESCRIPTION}|" \
  -e "s|^  author: .*|  author: ${AUTHOR_NAME}|" \
  -e "s|^# Plugin Title|# ${TITLE}|" \
  "$TEMPLATES/SKILL.template.md" > "$TARGET_DIR/SKILL.md"

# ----- open-design.json -----
# jq is the right tool for JSON edits, not sed. Substitute every field that
# the template ships with placeholder values for.
jq \
  --arg id "$PLUGIN_ID" \
  --arg title "$TITLE" \
  --arg desc "$DESCRIPTION" \
  --arg lane "$LANE" \
  --arg mode "$MODE" \
  --arg author "$AUTHOR_NAME" \
  '.name = $id
   | .title = $title
   | .description = $desc
   | (.tags // []) as $existing | .tags = ([$lane, $mode] | unique)
   | .author = { name: $author }
   | .od.taskKind = (if $lane == "create" then "new-generation" else $lane end)
   | .od.mode = $mode' \
  "$TEMPLATES/open-design.template.json" > "$TARGET_DIR/open-design.json"

# ----- README.md (en) -----
sed \
  -e "s|{{TITLE}}|${TITLE}|g" \
  -e "s|{{PLUGIN_ID}}|${PLUGIN_ID}|g" \
  -e "s|{{DESCRIPTION}}|${DESCRIPTION}|g" \
  -e "s|{{LANE}}|${LANE}|g" \
  -e "s|{{MODE}}|${MODE}|g" \
  "$TEMPLATES/README.template.md" > "$TARGET_DIR/README.md"

# ----- README.zh-CN.md (best-effort mirror) -----
# OD spec docs require a zh-CN mirror; community plugin READMEs don't strictly
# require one, but shipping a stub avoids the bilingual rule biting later if
# the plugin gets promoted to spec/examples. The agent can flesh it out
# (or replace the en-version contents) before push if the contributor speaks
# Chinese; otherwise this stub at least declares the intent.
if [[ -f "$TEMPLATES/README.template.zh-CN.md" ]]; then
  sed \
    -e "s|{{TITLE}}|${TITLE}|g" \
    -e "s|{{PLUGIN_ID}}|${PLUGIN_ID}|g" \
    -e "s|{{DESCRIPTION}}|${DESCRIPTION}|g" \
    -e "s|{{LANE}}|${LANE}|g" \
    -e "s|{{MODE}}|${MODE}|g" \
    "$TEMPLATES/README.template.zh-CN.md" > "$TARGET_DIR/README.zh-CN.md"
fi

# ----- --from-project: copy assets + auto-route paths in the manifest ----
# When the caller pointed us at an OD project folder, copy that project's
# files into the scaffolded plugin and update the manifest so paths resolve.
# Routing rule (matches what the SKILL.md flow describes):
#
#   <entry>.html and any sibling HTML / CSS / JS / image files
#       → preview/                    (the marketplace card preview)
#       → manifest.od.preview.entry  = ./preview/<entry-basename>
#
#   nested directories of HTML (e.g. screens/01-home.html)
#       → preview/<dir>/...           (preserve subdir)
#
#   .md / .txt / .json / .csv / other prose-or-config files
#       → assets/                    (referenced from SKILL.md as needed)
#
# We DO NOT copy:
#   - .artifact.json sidecars         (OD's internal metadata, not user content)
#   - .DS_Store and other OS noise
#   - data/ subdir                    (OD scratch)
#   - any file whose name starts with `od-contribute-`  (leftovers from
#     previous skill runs in the same project — would re-introduce stale
#     SKILL.md / PR-BODY into the new plugin)
if [[ -n "$FROM_PROJECT" && -n "$PROJECT_ASSETS_ROOT" ]]; then
  # Track copied paths so we can list them in the manifest's
  # od.context.assets[] field.
  COPIED_PATHS=$'\n'

  copy_asset() {
    local src="$1" rel="$2" dest_subdir="$3"
    local dest="$TARGET_DIR/$dest_subdir/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    COPIED_PATHS+="./${dest_subdir}/${rel}"$'\n'
  }

  while IFS= read -r -d '' src; do
    rel="${src#$PROJECT_ASSETS_ROOT/}"
    [[ -z "$rel" || "$rel" == "$src" ]] && continue
    case "$rel" in
      .DS_Store|*.DS_Store) continue ;;
      *.artifact.json)      continue ;;
      data/*)               continue ;;
      od-contribute-*)      continue ;;
    esac

    case "$rel" in
      *.html|*.css|*.js|*.mjs|*.cjs \
      |*.png|*.jpg|*.jpeg|*.gif|*.webp|*.svg|*.ico)
        copy_asset "$src" "$rel" "preview"
        ;;
      *)
        copy_asset "$src" "$rel" "assets"
        ;;
    esac
  done < <(find "$PROJECT_ASSETS_ROOT" -type f -print0 2>/dev/null)

  # Patch manifest: real preview entry, asset list, optional design-system.
  ENTRY_FROM_PROJECT="$(jq -r '.project.entry // ""' <<< "$INSPECT_JSON")"
  PREVIEW_ENTRY=""
  if [[ -n "$ENTRY_FROM_PROJECT" && -f "$TARGET_DIR/preview/$ENTRY_FROM_PROJECT" ]]; then
    PREVIEW_ENTRY="./preview/$ENTRY_FROM_PROJECT"
  elif [[ -f "$TARGET_DIR/preview/index.html" ]]; then
    PREVIEW_ENTRY="./preview/index.html"
  fi

  # Newline-separated list → JSON array.
  ASSETS_ARR_JSON="$(printf '%s' "$COPIED_PATHS" \
    | grep -v '^$' \
    | jq -R -s 'split("\n") | map(select(length > 0)) | map({path: .})')"

  TMP_MANIFEST="$TARGET_DIR/open-design.json.tmp"
  jq \
    --arg preview "$PREVIEW_ENTRY" \
    --arg ds "$DESIGN_SYSTEM" \
    --argjson assets "$ASSETS_ARR_JSON" \
    '
      if ($preview | length) > 0
        then .od.preview = { type: "html", entry: $preview }
        else .
      end
      | .od.context.assets = $assets
      | if ($ds | length) > 0
          then .od.designSystem = { primary: $ds }
          else .
        end
    ' "$TARGET_DIR/open-design.json" > "$TMP_MANIFEST" \
    && mv "$TMP_MANIFEST" "$TARGET_DIR/open-design.json"
fi

od::log "scaffolded plugin at $TARGET_DIR"
printf 'TARGET_DIR=%s\n' "$TARGET_DIR"
printf 'SKILL_PATH=%s\n' "$TARGET_DIR/SKILL.md"
printf 'MANIFEST_PATH=%s\n' "$TARGET_DIR/open-design.json"
