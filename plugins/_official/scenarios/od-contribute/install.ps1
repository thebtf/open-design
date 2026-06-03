# OD Contribute installer — Windows / PowerShell.
# Mirrors install.sh's behavior on macOS / Linux. See that file's header
# for the rationale; this is the same skill, same target dirs.
#
# Two ways to run this:
#
# 1) Tell your AI agent (Claude Code / Codex / Cursor / etc.) in the chat:
#
#      iwr -useb https://raw.githubusercontent.com/nexu-io/open-design/main/plugins/_official/scenarios/od-contribute/install.ps1 | iex
#
#    The agent's PowerShell tool runs this. You never open a terminal yourself.
#
# 2) Or paste the same line into PowerShell directly. (Run as your normal
#    user — admin is NOT required; everything writes under $env:USERPROFILE.)
#
# Override the source branch with $env:OD_CONTRIBUTE_BRANCH = 'feat/foo'
# (default: main).

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$Repo   = 'nexu-io/open-design'
$Branch = if ($env:OD_CONTRIBUTE_BRANCH) { $env:OD_CONTRIBUTE_BRANCH } else { 'main' }

function Write-Cyan  ($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Green ($msg) { Write-Host $msg -ForegroundColor Green }
function Write-Gray  ($msg) { Write-Host $msg -ForegroundColor DarkGray }
function Die ($msg) {
  Write-Host "[error] $msg" -ForegroundColor Red
  exit 1
}

Write-Cyan "Installing OD Contribute skill from $Repo@$Branch..."

# Pre-flight: tar is part of Windows 10 1803+ and Windows 11 by default.
# Older Windows can install it via 'choco install gnuwin32-tar.install' or
# similar; we error early so the user has a specific thing to fix.
foreach ($cmd in 'tar') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Die "$cmd is required but not on PATH. Windows 10 (1803+) and Windows 11 ship it; older builds need a manual install."
  }
}

$TmpDir = Join-Path $env:TEMP ("od-contribute-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

try {
  $TarballUrl = "https://github.com/$Repo/archive/refs/heads/$Branch.tar.gz"
  $Tarball    = Join-Path $TmpDir 'repo.tar.gz'

  # Use Invoke-WebRequest with -UseBasicParsing for cross-version compat.
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $TarballUrl -OutFile $Tarball
  } catch {
    Die "Failed to fetch $Repo@$Branch (does the branch exist?)`n  $($_.Exception.Message)"
  }

  # GitHub tarballs name the root dir <repo>-<branch>/, with slashes in
  # branch names converted to dashes.
  $TarballRoot = "open-design-" + ($Branch -replace '/', '-')
  $ScenarioPath = "$TarballRoot/plugins/_official/scenarios/od-contribute"

  Push-Location $TmpDir
  try {
    & tar -xzf $Tarball $ScenarioPath 2>$null
    if ($LASTEXITCODE -ne 0) {
      Die "tar extraction failed; the branch may have a different layout."
    }
  } finally {
    Pop-Location
  }

  $SkillSrc = Join-Path $TmpDir $ScenarioPath
  if (-not (Test-Path (Join-Path $SkillSrc 'SKILL.md'))) {
    Die "SKILL.md missing at expected path inside the tarball."
  }

  # The list of state files we preserve across reinstall — same allowlist
  # as install.sh's PRESERVE array. Keeps a sandboxed-agent .gh-token from
  # being wiped when the user re-runs the installer to upgrade.
  $Preserve = @('.gh-token')

  function Install-Skill-To {
    param(
      [string]$Dest,
      [string]$Label
    )

    # Stash any preserved files before we wipe.
    $Stash = $null
    foreach ($f in $Preserve) {
      $src = Join-Path $Dest $f
      if (Test-Path $src) {
        if (-not $Stash) { $Stash = Join-Path $env:TEMP ("od-contribute-stash-" + [Guid]::NewGuid()) }
        New-Item -ItemType Directory -Force -Path $Stash | Out-Null
        Copy-Item -Force $src (Join-Path $Stash $f)
      }
    }

    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    Copy-Item -Recurse -Force "$SkillSrc\*" $Dest

    if ($Stash) {
      foreach ($f in $Preserve) {
        $stashed = Join-Path $Stash $f
        if (Test-Path $stashed) {
          Copy-Item -Force $stashed (Join-Path $Dest $f)
        }
      }
      Remove-Item -Recurse -Force $Stash
    }

    Write-Green "  [OK] $Label"
    Write-Gray  "       $Dest"
  }

  $Home = $env:USERPROFILE

  # --- Claude Code (native) -------------------------------------------------
  Install-Skill-To -Dest (Join-Path $Home '.claude\skills\od-contribute') `
                   -Label 'Claude Code skill'

  # Synthesize the slash-command shim. Mirrors the heredoc in install.sh.
  $ClaudeCommandsDir = Join-Path $Home '.claude\commands'
  New-Item -ItemType Directory -Force -Path $ClaudeCommandsDir | Out-Null
  $SlashCommand = @'
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
'@
  Set-Content -Path (Join-Path $ClaudeCommandsDir 'od-contribute.md') -Value $SlashCommand -Encoding UTF8
  Write-Green "  [OK] Claude Code slash command (/od-contribute)"
  Write-Gray  "       $(Join-Path $ClaudeCommandsDir 'od-contribute.md')"

  # --- Codex CLI (canonical) ------------------------------------------------
  Install-Skill-To -Dest (Join-Path $Home '.agents\skills\od-contribute') `
                   -Label 'Codex CLI skill (~/.agents/skills/)'

  # --- Codex CLI (legacy) — only if the user actually has Codex -------------
  if (Test-Path (Join-Path $Home '.codex')) {
    Install-Skill-To -Dest (Join-Path $Home '.codex\skills\od-contribute') `
                     -Label 'Codex CLI skill (legacy ~/.codex/skills/)'
  }
}
finally {
  Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Green "Done."
Write-Host ""
Write-Cyan "How to use it:"
Write-Host @"

  In Claude Code:  type  /od-contribute  in any chat.
  In Codex CLI:    type  @od-contribute  or pick "Open Design Contributor" from /skills.
  In other agents: ask the agent to follow ~/.claude/skills/od-contribute/SKILL.md

The skill walks you through one of:
  * shipping a Skill / Design System you made with Open Design
  * shipping a plugin (auto-derived from your OD project)
  * translating a doc to a new language
  * fixing a typo or writing a use-case blog
  * reporting a clean bug

Need help? Open Design Discord:  https://discord.gg/qhbcCH8Am4
"@
