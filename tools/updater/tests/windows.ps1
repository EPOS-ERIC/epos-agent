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
Write-Host "Installer tests passed on PowerShell $($PSVersionTable.PSVersion)"
