Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../.."))
$installerPath = Join-Path $root "install.ps1"
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
[void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root "bin/epos-agent.ps1"), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
# Load function definitions only: these tests never run the installer or winget.
$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }
$actualPython = Get-PythonCommand
if (-not $actualPython -or $actualPython.Version -lt [version]"3.11") { throw "Could not detect the installed supported Python" }
function Test-PythonLauncher {
  if ($args[0] -eq "-3.14") { $global:LASTEXITCODE = 1; return }
  $global:LASTEXITCODE = 0
  if ($args[0] -eq "-3.13") { return "3.10.9" }
  if ($args[0] -eq "-3.12") { return "3.12.1" }
  return "3.10.9"
}
function Get-CommandPath([string]$Name) { if ($Name -eq "py.exe") { return "Test-PythonLauncher" }; return $null }
$selectedPython = Get-PythonCommand
if ($selectedPython.Arguments[0] -ne "-3.12") { throw "Must skip unavailable and obsolete launcher versions" }
$actualWinget = ${function:Invoke-Winget}
$actualInstallPackage = ${function:Install-WingetPackage}

function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$script:packages = @()
$script:nodeVersion = [version]"22.19.0"
$script:python = [PSCustomObject]@{ Path = "supported-python"; Arguments = @(); Version = [version]"3.13" }
function Get-CommandPath([string]$Name) { if ($Name -eq "npm.cmd") { return "npm.cmd" }; return $null }
function Get-NodeVersion { return $script:nodeVersion }
function Get-PythonCommand { return $script:python }
function Install-WingetPackage([string]$Id, [bool]$Upgrade = $false) {
  $script:packages += "$Id/$Upgrade"
  if ($Id -eq "OpenJS.NodeJS.LTS") { $script:nodeVersion = [version]"22.19.0" }
  if ($Id -eq "Python.Python.3.13") { $script:python = [PSCustomObject]@{ Path = "python"; Arguments = @(); Version = [version]"3.13" } }
}
$selected = Ensure-Prerequisites
Assert ($selected.Path -eq "supported-python") "Must reuse compatible Python"
Assert ($script:packages.Count -eq 0) "Compatible tools must not require winget"
$script:nodeVersion = [version]"20.0.0"
[void](Ensure-Prerequisites)
Assert ($script:packages -contains "OpenJS.NodeJS.LTS/True") "Old Node must trigger upgrade"
$script:packages = @()
$script:python = $null
[void](Ensure-Prerequisites)
Assert ($script:packages -contains "Python.Python.3.13/False") "Missing compatible Python must trigger installation"
${function:Invoke-Winget} = $actualWinget
$failed = $false
try { Invoke-Winget -Arguments @("install", "--id", "Python.Python.3.13") } catch {
  $failed = $_.Exception.Message -like "*Python.Python.3.13*App Installer*"
}
Assert $failed "Missing winget must report the missing prerequisite"
${function:Install-WingetPackage} = $actualInstallPackage
$script:wingetArguments = @()
function Invoke-Winget([string[]]$Arguments) { $script:wingetArguments = $Arguments }
Install-WingetPackage "OpenJS.NodeJS.LTS" $true
Assert ($script:wingetArguments[0] -eq "upgrade") "Upgrade must not force a reinstall"
${function:Invoke-Winget} = $actualWinget
function Get-CommandPath([string]$Name) { return "Test-Winget" }
function Refresh-CommandPath {}
function Test-Winget { $global:LASTEXITCODE = $script:wingetCode }
foreach ($code in @(0, -1978335189, -1978335135)) {
  $script:wingetCode = $code
  Invoke-Winget -Arguments @("install", "--id", "Python.Python.3.13")
}
$script:wingetCode = 123
$failed = $false
try { Invoke-Winget -Arguments @("install", "--id", "Python.Python.3.13") } catch {
  $failed = $_.Exception.Message -like "*code 123*"
}
Assert $failed "Real winget failures must retain the exit code"

$savedUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$savedProcessPath = $env:Path
$testDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("epos-install-" + [guid]::NewGuid())
try {
  $InstallRoot = Join-Path $testDirectory "new agent"
  $oldRoot = Join-Path $testDirectory "old agent"
  $unrelatedRoot = Join-Path $testDirectory "unrelated"
  $mismatchedRoot = Join-Path $testDirectory "mismatched"
  foreach ($directory in @($InstallRoot, $oldRoot, $unrelatedRoot, $mismatchedRoot)) {
    New-Item -ItemType Directory -Path (Join-Path $directory "bin") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $directory "bin/epos-agent.ps1") -Value "launcher"
  }
  $newBin = Join-Path $InstallRoot "bin"
  $oldBin = Join-Path $oldRoot "bin"
  $unrelatedBin = Join-Path $unrelatedRoot "bin"
  $mismatchedBin = Join-Path $mismatchedRoot "bin"
  Set-Content -LiteralPath (Join-Path $oldRoot ".epos-agent-installation") -Value "EPOS_AGENT_ROOT=$oldRoot"
  Set-Content -LiteralPath (Join-Path $mismatchedRoot ".epos-agent-installation") -Value "EPOS_AGENT_ROOT=$oldRoot"
  Set-Content -LiteralPath (Join-Path $oldBin "epos-agent") -Value "old shell launcher"
  Set-Content -LiteralPath (Join-Path $oldRoot "credentials") -Value "keep credentials"
  Set-Content -LiteralPath (Join-Path $oldBin "other-tool.exe") -Value "keep other tool"
  $testPath = '"' + $oldBin + '\";' + $unrelatedBin + ';' + $mismatchedBin + ';' + $newBin.ToUpper() + '\;' + $oldBin
  [Environment]::SetEnvironmentVariable("Path", $testPath, "User")
  $env:Path = "$testPath;$savedProcessPath"
  Register-AgentCommand
  $registeredPath = [Environment]::GetEnvironmentVariable("Path", "User")
  Assert ($registeredPath -ceq "$newBin;$unrelatedBin;$mismatchedBin") "Must remove old and duplicate entries while preserving unrelated PATH entries"
  Assert (($env:Path -split ';')[0] -ceq $newBin) "The current process must prefer the new installation"
  Assert ($env:Path -notlike "*$oldBin*") "The current process must remove the old installation"
  Assert (-not (Test-Path -LiteralPath (Join-Path $oldBin "epos-agent.ps1"))) "Must remove the previous PowerShell launcher"
  Assert (-not (Test-Path -LiteralPath (Join-Path $oldBin "epos-agent"))) "Must remove the previous shell launcher"
  Assert (Test-Path -LiteralPath (Join-Path $newBin "epos-agent.ps1")) "Must keep the current launcher"
  Assert (Test-Path -LiteralPath (Join-Path $unrelatedBin "epos-agent.ps1")) "Must keep unrecognized launchers"
  Assert (Test-Path -LiteralPath (Join-Path $mismatchedBin "epos-agent.ps1")) "Must keep installations with mismatched markers"
  Assert ((Get-Content -LiteralPath (Join-Path $oldRoot "credentials") -Raw).Trim() -eq "keep credentials") "Must preserve user data"
  Assert (Test-Path -LiteralPath (Join-Path $oldBin "other-tool.exe")) "Must preserve unrelated binaries"
  Register-AgentCommand
  Assert ([Environment]::GetEnvironmentVariable("Path", "User") -ceq $registeredPath) "Repeated installation must not duplicate PATH entries"
} finally {
  [Environment]::SetEnvironmentVariable("Path", $savedUserPath, "User")
  $env:Path = $savedProcessPath
  if (Test-Path -LiteralPath $testDirectory) { Remove-Item -LiteralPath $testDirectory -Recurse -Force }
}
Write-Host "Installer tests passed on PowerShell $($PSVersionTable.PSVersion)"
exit 0
