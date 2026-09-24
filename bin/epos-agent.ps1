[CmdletBinding()]
param(
  [switch]$SetupGemini
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = if ($env:EPOS_AGENT_ROOT) {
  [System.IO.Path]::GetFullPath($env:EPOS_AGENT_ROOT)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
}

function Stop-Agent([string]$Message) {
  throw "epos-agent: $Message"
}

function Import-Profile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $allowed = @("GEMINI_API_KEY", "EPOS_PROVIDER", "EPOS_MODEL", "EPOS_THINKING", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL")
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match "^\s*([A-Z0-9_]+)=(.*)$" -and $allowed -contains $matches[1]) {
      Set-Item -Path "Env:$($matches[1])" -Value $matches[2]
    }
  }
}

function Protect-Profile([string]$Path) {
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
  $acl.SetOwner($currentUser)
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $currentUser,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  ))
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Set-UpGemini {
  if (-not [Environment]::UserInteractive) { Stop-Agent "-SetupGemini requires an interactive terminal" }
  $profile = Join-Path $Root "config/profile.env"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profile) | Out-Null
  Write-Host "Create a Gemini API key in Google AI Studio:"
  Write-Host "https://aistudio.google.com/app/apikey"
  $secureKey = Read-Host "Paste the key" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    $geminiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  if ([string]::IsNullOrWhiteSpace($geminiKey)) { Stop-Agent "no Gemini API key was provided" }

  $existing = @()
  if (Test-Path -LiteralPath $profile) {
    $existing = Get-Content -LiteralPath $profile | Where-Object { $_ -notmatch "^\s*(GEMINI_API_KEY|EPOS_PROVIDER|EPOS_MODEL)=" }
  }
  Set-Content -LiteralPath $profile -Value @($existing + "GEMINI_API_KEY=$geminiKey" + "EPOS_PROVIDER=google") -Encoding UTF8
  Protect-Profile $profile
  $geminiKey = $null
  Write-Host "Gemini is configured for EPOS Agent. Start it normally, then use /model to choose a Gemini model."
}

if ($SetupGemini) {
  Set-UpGemini
  exit 0
}

$piBin = Join-Path $Root ".runtime/node_modules/.bin/pi.cmd"
if (-not (Test-Path -LiteralPath $piBin)) { Stop-Agent "cannot find executable pi runtime" }

New-Item -ItemType Directory -Force -Path @(
  (Join-Path $Root "cache"),
  (Join-Path $Root "sessions"),
  (Join-Path $Root "logs"),
  (Join-Path $Root "logs/provenance"),
  (Join-Path $Root "config/pi-agent")
) | Out-Null

Import-Profile (Join-Path $Root "config/profile.env")
$provider = if ($env:EPOS_PROVIDER) { $env:EPOS_PROVIDER } else { $env:PI_PROVIDER }
$model = if ($env:EPOS_MODEL) { $env:EPOS_MODEL } else { $env:PI_MODEL }
$thinking = if ($env:EPOS_THINKING) { $env:EPOS_THINKING } else { $env:PI_REASONING_LEVEL }

Clear-Host
Write-Host "EPOS Agent - European Plate Observing System" -ForegroundColor DarkYellow
Write-Host "Solid Earth data services, metadata, provenance and discovery" -ForegroundColor DarkGreen
Write-Host ""

$env:EPOS_AGENT_ROOT = $Root
$env:PI_CODING_AGENT_DIR = Join-Path $Root "config/pi-agent"
$env:PI_CODING_AGENT_SESSION_DIR = Join-Path $Root "sessions"
$env:PI_SKIP_VERSION_CHECK = "1"
$env:XDG_CACHE_HOME = Join-Path $Root "cache/xdg"

$piArgs = @(
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--session-dir", (Join-Path $Root "sessions"),
  "--system-prompt", (Get-Content -LiteralPath (Join-Path $Root "prompts/SYSTEM.md") -Raw),
  "--skill", (Join-Path $Root "skills"),
  "--extension", (Join-Path $Root "tools/agent-runtime/index.ts"),
  "--theme", (Join-Path $Root "themes/epos-corporate.json"),
  "--use-theme", "epos-corporate",
  "--tools", "read,grep,find,ls,write,edit,epos_load_tools,epos_manage_study,epos_search,epos_search_page,epos_select_candidate,epos_search_filter,epos_organizations,epos_details,epos_prepare_execute,epos_execute,epos_inspect,epos_visualize,epos_fetch,epos_prepare_visualization,epos_run_python,epos_finalize_notebook,epos_show_image,epos_fdsnws_event_call"
)
if ($provider) { $piArgs += @("--provider", $provider) }
if ($model) { $piArgs += @("--model", $model) }
if ($thinking) { $piArgs += @("--thinking", $thinking) }

& $piBin @piArgs @args
exit $LASTEXITCODE
