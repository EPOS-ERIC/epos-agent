[CmdletBinding()]
param([switch]$UpdateDependenciesOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion -lt [version]"5.1") {
  throw "[EPOS] ERROR: PowerShell 5.1 or newer is required."
}

$InstallRoot = if ($env:EPOS_INSTALL_ROOT) {
  [System.IO.Path]::GetFullPath($env:EPOS_INSTALL_ROOT)
} else {
  $PSScriptRoot
}

function Write-Status([string]$Message) {
  Write-Host "[EPOS] $Message"
}

function Stop-Install([string]$Message) {
  throw "[EPOS] ERROR: $Message"
}

function Refresh-CommandPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machinePath, $userPath, $env:Path) | Where-Object { $_ } | Select-Object -Unique) -join ";"
}

function Get-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Invoke-Winget([string[]]$Arguments) {
  $winget = Get-CommandPath "winget"
  if (-not $winget) {
    Stop-Install "Missing prerequisite: $($Arguments[2]). Install Microsoft App Installer (https://aka.ms/getwinget), or install Node.js >= 22.19.0 and Python >= 3.11 manually, then re-run."
  }
  & $winget @Arguments | Out-Host
  $code = $LASTEXITCODE
  # No applicable upgrade is acceptable only if the subsequent version check passes.
  if ($code -notin @(0, -1978335189, -1978335135)) {
    Stop-Install "winget exited with code ${code}: winget $($Arguments -join ' ')"
  }
  Refresh-CommandPath
}

function Install-WingetPackage([string]$Id, [bool]$Upgrade = $false) {
  Write-Status "Installing $Id"
  $arguments = @("install", "--id", $Id, "--exact", "--source", "winget", "--silent", "--accept-package-agreements", "--accept-source-agreements")
  if ($Upgrade) { $arguments[0] = "upgrade" }
  Invoke-Winget -Arguments $arguments
}

function Get-NodeVersion {
  $node = Get-CommandPath "node"
  if (-not $node) { return $null }
  $output = & $node --version 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  $text = ($output -join "").Trim().TrimStart("v")
  if (-not $text) { return $null }
  try { return [version]$text } catch { return $null }
}

function Get-PythonCommand {
  # Missing launcher versions are expected probe failures, including on PowerShell 5.1.
  $ErrorActionPreference = "Continue"
  $candidates = @()
  $launcher = Get-CommandPath "py.exe"
  if ($launcher) {
    foreach ($minor in 14, 13, 12, 11) {
      $candidates += [PSCustomObject]@{ Path = $launcher; Arguments = @("-3.$minor") }
    }
    $candidates += [PSCustomObject]@{ Path = $launcher; Arguments = @("-3") }
  }
  foreach ($name in @("python.exe", "python3.exe")) {
    foreach ($command in @(Get-Command $name -All -ErrorAction SilentlyContinue)) {
      if ($command.Source -and $command.Source -notlike "*\Microsoft\WindowsApps\*") {
        $candidates += [PSCustomObject]@{ Path = $command.Source; Arguments = @() }
      }
    }
  }
  foreach ($base in @((Join-Path $env:LOCALAPPDATA "Programs/Python"), $env:ProgramFiles)) {
    foreach ($executable in @(Get-ChildItem -Path (Join-Path $base "Python*/python.exe") -ErrorAction SilentlyContinue)) {
      $candidates += [PSCustomObject]@{ Path = $executable.FullName; Arguments = @() }
    }
  }
  foreach ($candidate in $candidates) {
    $versionText = & $candidate.Path @($candidate.Arguments + @("-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))")) 2>$null
    if ($LASTEXITCODE -ne 0) { continue }
    $version = $null
    if ([version]::TryParse(($versionText -join "").Trim(), [ref]$version) -and $version -ge [version]"3.11") {
      return [PSCustomObject]@{ Path = $candidate.Path; Arguments = $candidate.Arguments; Version = $version }
    }
  }
  return $null
}

function Ensure-Prerequisites {
  $nodeVersion = Get-NodeVersion
  if (-not $nodeVersion) {
    Install-WingetPackage "OpenJS.NodeJS.LTS"
  } elseif ($nodeVersion -lt [version]"22.19.0") {
    Install-WingetPackage "OpenJS.NodeJS.LTS" $true
  }

  if (-not (Get-CommandPath "npm.cmd")) {
    Stop-Install "npm is required after installing Node.js. Open a new PowerShell window and re-run this command."
  }
  $nodeVersion = Get-NodeVersion
  if (-not $nodeVersion -or $nodeVersion -lt [version]"22.19.0") {
    Stop-Install "Node.js >= 22.19.0 is required. Open a new PowerShell window after the upgrade and re-run this command."
  }

  $python = Get-PythonCommand
  if (-not $python) {
    Install-WingetPackage "Python.Python.3.13"
  }
  $python = Get-PythonCommand
  if (-not $python -or $python.Version -lt [version]"3.11") {
    Stop-Install "Python >= 3.11 is required. Open a new PowerShell window after the upgrade and re-run this command."
  }
  return $python
}

function Invoke-Python([object]$Python, [string[]]$Arguments) {
  & $Python.Path @($Python.Arguments + $Arguments)
  if ($LASTEXITCODE -ne 0) { Stop-Install "Python command failed: $($Arguments -join ' ')" }
}

function Install-Application([object]$Python) {
  $runtime = Join-Path $InstallRoot ".runtime"
  Write-Status "Installing pi coding agent locally"
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  & npm.cmd install --prefix $runtime --no-fund --no-audit "@earendil-works/pi-coding-agent@latest"
  if ($LASTEXITCODE -ne 0) { Stop-Install "Could not install pi coding agent." }

  & node (Join-Path $InstallRoot "tools/updater/update.cjs") patch-pi $InstallRoot
  if ($LASTEXITCODE -ne 0) { Stop-Install "Could not configure pi coding agent." }

  $environments = @(
    @{ Name = "EPOS MCP"; Path = "services/mcp-epos/.venv"; Requirements = "services/mcp-epos/requirements.txt" },
    @{ Name = "FDSN MCP"; Path = "services/mcp-fdsnws-event/.venv"; Requirements = $null; Package = "services/mcp-fdsnws-event" },
    @{ Name = "EPOS visualizations"; Path = "tools/visualization/.venv"; Requirements = "tools/visualization/requirements-core.txt" }
  )
  foreach ($environment in $environments) {
    $environmentPath = Join-Path $InstallRoot $environment.Path
    $venvPython = Join-Path $environmentPath "Scripts/python.exe"
    $validEnvironment = $false
    if (Test-Path -LiteralPath $venvPython) {
      $validEnvironment = & {
        $ErrorActionPreference = "Continue"
        & $venvPython -c "import sys; assert sys.version_info >= (3, 11)" 2>$null
        $LASTEXITCODE -eq 0
      }
    }
    if (-not $validEnvironment) {
      Write-Status "Creating Python environment for $($environment.Name)"
      Invoke-Python $Python @("-m", "venv", "--clear", $environmentPath)
    }
    & $venvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { Stop-Install "Could not upgrade pip for $($environment.Name)." }
    if ($environment.Requirements) {
      & $venvPython -m pip install -r (Join-Path $InstallRoot $environment.Requirements)
    } else {
      & $venvPython -m pip install (Join-Path $InstallRoot $environment.Package)
    }
    if ($LASTEXITCODE -ne 0) { Stop-Install "Could not install dependencies for $($environment.Name)." }
  }

  $directories = @("workspace", "config/pi-agent", "cache", "logs/provenance", "sessions")
  foreach ($directory in $directories) {
    New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot $directory) | Out-Null
  }
  $workspaceKeep = Join-Path $InstallRoot "workspace/.gitkeep"
  if (-not (Test-Path -LiteralPath $workspaceKeep)) { New-Item -ItemType File -Path $workspaceKeep | Out-Null }

  $profile = Join-Path $InstallRoot "config/profile.env"
  if (-not (Test-Path -LiteralPath $profile)) {
    Copy-Item -LiteralPath (Join-Path $InstallRoot "config/profile.env.example") -Destination $profile
  }
  Set-Content -LiteralPath (Join-Path $InstallRoot ".epos-agent-installation") -Value "EPOS_AGENT_ROOT=$InstallRoot" -Encoding ASCII

  if ($UpdateDependenciesOnly) { return }

  # ── Make epos-agent available globally ─────────────────────────────────────
  $binDir = Join-Path $InstallRoot "bin"
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (@($userPath -split ";") -notcontains $binDir) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    $env:Path = "$env:Path;$binDir"
    Write-Status "Added $binDir to your user PATH."
    Write-Status "Open a new PowerShell window for the change to take effect."
  }
}

Write-Status "Preparing native Windows installation in $InstallRoot"
$python = Ensure-Prerequisites
if ([System.IO.Path]::GetFullPath($PSScriptRoot) -ne $InstallRoot) {
  & node (Join-Path $PSScriptRoot "tools/updater/update.cjs") copy $PSScriptRoot $InstallRoot
  if ($LASTEXITCODE -ne 0) { Stop-Install "Could not prepare installation directory." }
}
Install-Application $python
if (-not $UpdateDependenciesOnly) {
  & node (Join-Path $InstallRoot "tools/updater/update.cjs") init $InstallRoot
  if ($LASTEXITCODE -ne 0) { Stop-Install "Could not initialize update metadata." }
}

Write-Host ""
Write-Status "Installation completed."
Write-Host "[EPOS]"
Write-Host "[EPOS]  To configure your provider/API key, edit config/profile.env"
Write-Host "[EPOS]"
Write-Host "[EPOS]  To start EPOS Agent, open a new PowerShell window and run:"
Write-Host "[EPOS]    epos-agent"
Write-Host "[EPOS]"
