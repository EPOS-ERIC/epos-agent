[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion -lt [version]"5.1") {
  throw "[EPOS] ERROR: PowerShell 5.1 or newer is required."
}

$RepositoryUrl = "https://github.com/danielebailo/epos-agent.git"
$RepositoryBranch = "main"
$InstallRoot = if ($env:EPOS_INSTALL_ROOT) {
  [System.IO.Path]::GetFullPath($env:EPOS_INSTALL_ROOT)
} else {
  Join-Path $env:USERPROFILE "epos-agent"
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
    Stop-Install "winget is required. Install Microsoft's App Installer, then re-run this command."
  }
  & $winget @Arguments
  if ($LASTEXITCODE -ne 0) {
    Stop-Install "winget failed while running: winget $($Arguments -join ' ')"
  }
  Refresh-CommandPath
}

function Install-WingetPackage([string]$Id, [bool]$Force = $false) {
  Write-Status "Installing $Id"
  $arguments = @("install", "--id", $Id, "--exact", "--source", "winget", "--silent", "--accept-package-agreements", "--accept-source-agreements")
  if ($Force) { $arguments += "--force" }
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
  $pythonLauncher = Get-CommandPath "py"
  if ($pythonLauncher) {
    $output = & $pythonLauncher -3 -c "import sys; print('.'.join(map(str, sys.version_info[:3])))" 2>$null
    $version = ($output -join "").Trim()
    if ($LASTEXITCODE -eq 0) {
      try {
        return [PSCustomObject]@{ Path = $pythonLauncher; Arguments = @("-3"); Version = [version]$version }
      } catch {}
    }
  }

  $python = Get-CommandPath "python"
  if ($python) {
    $output = & $python -c "import sys; print('.'.join(map(str, sys.version_info[:3])))" 2>$null
    $version = ($output -join "").Trim()
    if ($LASTEXITCODE -eq 0) {
      try {
        return [PSCustomObject]@{ Path = $python; Arguments = @(); Version = [version]$version }
      } catch {}
    }
  }
  return $null
}

function Ensure-Prerequisites {
  if (-not (Get-CommandPath "winget")) {
    Stop-Install "winget is required. Install Microsoft's App Installer, then re-run this command."
  }

  if (-not (Get-CommandPath "git")) {
    Install-WingetPackage "Git.Git"
  }

  $nodeVersion = Get-NodeVersion
  if (-not $nodeVersion) {
    Install-WingetPackage "OpenJS.NodeJS.LTS"
  } elseif ($nodeVersion -lt [version]"22.19.0") {
    Install-WingetPackage "OpenJS.NodeJS.LTS" $true
  }

  if (-not (Get-CommandPath "npm")) {
    Stop-Install "npm is required after installing Node.js. Open a new PowerShell window and re-run this command."
  }
  $nodeVersion = Get-NodeVersion
  if (-not $nodeVersion -or $nodeVersion -lt [version]"22.19.0") {
    Stop-Install "Node.js >= 22.19.0 is required. Open a new PowerShell window after the upgrade and re-run this command."
  }

  $python = Get-PythonCommand
  if (-not $python) {
    Install-WingetPackage "Python.Python.3.13"
  } elseif ($python.Version -lt [version]"3.11") {
    Install-WingetPackage "Python.Python.3.13" $true
  }
  $python = Get-PythonCommand
  if (-not $python -or $python.Version -lt [version]"3.11") {
    Stop-Install "Python >= 3.11 is required. Open a new PowerShell window after the upgrade and re-run this command."
  }
  return $python
}

function Test-OfficialInstallation([string]$Path) {
  if (-not (Test-Path -LiteralPath (Join-Path $Path ".git"))) { return $false }
  $originOutput = & git -C $Path remote get-url origin 2>$null
  if ($LASTEXITCODE -ne 0) { return $false }
  $origin = ($originOutput -join "").Trim()
  if ($origin -ne $RepositoryUrl) { return $false }
  $branchOutput = & git -C $Path branch --show-current 2>$null
  if ($LASTEXITCODE -ne 0) { return $false }
  $branch = ($branchOutput -join "").Trim()
  return $LASTEXITCODE -eq 0 -and $branch -eq $RepositoryBranch
}

function Get-Repository {
  if (Test-Path -LiteralPath $InstallRoot) {
    $entries = @(Get-ChildItem -LiteralPath $InstallRoot -Force)
    if ($entries.Count -gt 0 -and -not (Test-OfficialInstallation $InstallRoot)) {
      Stop-Install "$InstallRoot is not a clean EPOS Agent clone from $RepositoryUrl. Choose another EPOS_INSTALL_ROOT."
    } elseif ($entries.Count -gt 0) {
      $changes = (& git -C $InstallRoot status --porcelain --untracked-files=no 2>$null)
      if ($LASTEXITCODE -ne 0 -or $changes) {
        Stop-Install "$InstallRoot has tracked changes. Commit or discard them before updating."
      }
      Write-Status "Updating EPOS Agent in $InstallRoot"
      & git -C $InstallRoot pull --ff-only origin $RepositoryBranch
      if ($LASTEXITCODE -ne 0) { Stop-Install "Could not update the existing EPOS Agent installation." }
      return
    }
  }

  $parent = Split-Path -Parent $InstallRoot
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Write-Status "Cloning EPOS Agent into $InstallRoot"
  & git clone --depth 1 --branch $RepositoryBranch $RepositoryUrl $InstallRoot
  if ($LASTEXITCODE -ne 0) { Stop-Install "Could not clone EPOS Agent." }
}

function Invoke-Python([object]$Python, [string[]]$Arguments) {
  & $Python.Path @($Python.Arguments + $Arguments)
  if ($LASTEXITCODE -ne 0) { Stop-Install "Python command failed: $($Arguments -join ' ')" }
}

function Install-Application([object]$Python) {
  $runtime = Join-Path $InstallRoot ".runtime"
  Write-Status "Installing pi coding agent locally"
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  & npm install --prefix $runtime --no-fund --no-audit "@earendil-works/pi-coding-agent@latest"
  if ($LASTEXITCODE -ne 0) { Stop-Install "Could not install pi coding agent." }

  $environments = @(
    @{ Name = "EPOS MCP"; Path = "services/mcp-epos/.venv"; Requirements = "services/mcp-epos/requirements.txt" },
    @{ Name = "FDSN MCP"; Path = "services/mcp-fdsnws-event/.venv"; Requirements = $null; Package = "services/mcp-fdsnws-event" },
    @{ Name = "EPOS visualizations"; Path = "tools/visualization/.venv"; Requirements = "tools/visualization/requirements-core.txt" }
  )
  foreach ($environment in $environments) {
    $environmentPath = Join-Path $InstallRoot $environment.Path
    $venvPython = Join-Path $environmentPath "Scripts/python.exe"
    if (-not (Test-Path -LiteralPath $venvPython)) {
      Write-Status "Creating Python environment for $($environment.Name)"
      Invoke-Python $Python @("-m", "venv", $environmentPath)
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
}

function New-DesktopLauncher {
  $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
  if (-not $desktop) { Stop-Install "Could not determine the current user's Desktop directory." }
  $launcherPath = Join-Path $desktop "EPOS Agent.cmd"
  $launcherScript = Join-Path $InstallRoot "bin/epos-agent.ps1"
  $content = @(
    "@echo off",
    "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcherScript`"",
    "set `"EPOS_EXIT_CODE=%ERRORLEVEL%`"",
    "echo.",
    "pause",
    "exit /b %EPOS_EXIT_CODE%"
  )
  Set-Content -LiteralPath $launcherPath -Value $content -Encoding ASCII
  Write-Status "Created Desktop launcher: $launcherPath"
}

Write-Status "Preparing native Windows installation in $InstallRoot"
$python = Ensure-Prerequisites
Get-Repository
Install-Application $python
New-DesktopLauncher
Write-Status "Installation completed. Start EPOS Agent by double-clicking EPOS Agent.cmd on your Desktop."
