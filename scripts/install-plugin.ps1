[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Json,
  [string]$RepositoryRoot,
  [string]$CodexExecutable,
  [string]$CodexHome,
  [switch]$InstallCodexCli,
  [string]$ProgressPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$marketplaceName = "codex-inter-agent-local"
$pluginName = "codex-inter-agent-messaging"
$pluginSelector = "$pluginName@$marketplaceName"
$script:CurrentStep = "Initialize installer"
$script:LocationPushed = $false
$script:OriginalCodexHome = $env:CODEX_HOME
$script:TotalInstallSteps = 6
$completedSteps = [System.Collections.Generic.List[string]]::new()
$officialCodexInstallerUrl = "https://chatgpt.com/codex/install.ps1"

function Write-ProgressState {
  param(
    [string]$State,
    [string]$Message,
    [int]$Completed = $completedSteps.Count
  )

  if ([string]::IsNullOrWhiteSpace($ProgressPath)) {
    return
  }
  $payload = [ordered]@{
    state = $State
    step = $script:CurrentStep
    message = $Message
    completed = $Completed
    timestamp = [DateTimeOffset]::Now.ToString("o")
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($ProgressPath, $payload, $utf8)
}

function Write-InstallerMessage {
  param([string]$Message)
  if (-not $Json) {
    Write-Host $Message
  }
}

function Resolve-RequiredCommand {
  param(
    [string]$Name,
    [string]$InstallHint
  )

  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $command) {
    throw "Required command '$Name' was not found. $InstallHint"
  }
  return $command.Source
}

function Test-PrivateCodexExecutable {
  param([string]$PathValue)

  $normalized = Normalize-PathForComparison $PathValue
  return $normalized -match "(?i)\\WindowsApps\\OpenAI\.Codex_.*\\app\\resources\\codex\.exe$" -or
    $normalized -match "(?i)\\\.vscode\\extensions\\openai\.chatgpt-[^\\]+\\bin\\.*\\codex\.exe$"
}

function Resolve-PublicCodexCommand {
  param([string]$ExplicitPath)

  if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
    if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) {
      throw "The selected Codex CLI executable does not exist: $ExplicitPath"
    }
    $resolved = (Resolve-Path -LiteralPath $ExplicitPath).Path
    if (Test-PrivateCodexExecutable $resolved) {
      throw "The selected executable is private to the Codex desktop app or an editor extension. Select a standalone Codex CLI executable instead."
    }
    return $resolved
  }

  $pathCandidate = Get-Command "codex" -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $pathCandidate -and -not (Test-PrivateCodexExecutable $pathCandidate.Source)) {
    return $pathCandidate.Source
  }

  $standalone = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin\codex.exe"
  if (Test-Path -LiteralPath $standalone -PathType Leaf) {
    return (Resolve-Path -LiteralPath $standalone).Path
  }
  return $null
}

function Install-OfficialCodexCli {
  param(
    [string]$InstallDirectory,
    [string]$Release
  )

  $script:CurrentStep = "Install official Codex CLI"
  Write-InstallerMessage "Installing the official Codex CLI..."
  Write-ProgressState "running" "Installing the official Codex CLI"
  $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-cli-installer-" + [guid]::NewGuid().ToString("N"))
  $downloadedScript = Join-Path $temporaryDirectory "install.ps1"
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
  try {
    Invoke-WebRequest -UseBasicParsing $officialCodexInstallerUrl -OutFile $downloadedScript
    $previousNonInteractive = $env:CODEX_NON_INTERACTIVE
    $previousInstallDirectory = $env:CODEX_INSTALL_DIR
    $previousCodexHome = $env:CODEX_HOME
    $previousCodexRelease = $env:CODEX_RELEASE
    try {
      $env:CODEX_NON_INTERACTIVE = "1"
      $env:CODEX_INSTALL_DIR = $InstallDirectory
      $env:CODEX_RELEASE = $Release
      # The standalone command depends on its package cache under CODEX_HOME.
      # Use the same directory through its short alias to avoid the official
      # installer's bundled tar Unicode-path limitation without relocating it.
      $env:CODEX_HOME = Get-CodexInstallerCompatiblePath $previousCodexHome
      $null = Invoke-NativeCommand "powershell.exe" @(
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $downloadedScript
      ) -Capture -HideOutput
    } finally {
      $env:CODEX_NON_INTERACTIVE = $previousNonInteractive
      $env:CODEX_INSTALL_DIR = $previousInstallDirectory
      $env:CODEX_HOME = $previousCodexHome
      $env:CODEX_RELEASE = $previousCodexRelease
    }
  } finally {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-NativeCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [switch]$Capture,
    [switch]$HideOutput
  )

  $mustCapture = $Capture -or $Json -or $HideOutput
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Native stderr is diagnostic text; the process exit code determines success.
    $ErrorActionPreference = "Continue"
    if ($mustCapture) {
      $lines = @(& $FilePath @Arguments 2>&1)
      $exitCode = $LASTEXITCODE
      $output = ($lines | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
      if (-not $HideOutput -and -not $Json -and $output.Length -gt 0) {
        Write-Host $output
      }
    } else {
      & $FilePath @Arguments
      $exitCode = $LASTEXITCODE
      $output = ""
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($exitCode -ne 0) {
    $display = "$FilePath $($Arguments -join ' ')"
    $detail = if ($output.Length -gt 0) { "`n$output" } else { "" }
    throw "Command failed with exit code $exitCode`: $display$detail"
  }
  return $output
}

function Get-SemanticVersion {
  param(
    [string]$Text,
    [string]$CommandName
  )

  $match = [regex]::Match($Text, "(?m)(\d+)\.(\d+)\.(\d+)")
  if (-not $match.Success) {
    throw "Could not parse the $CommandName version from: $Text"
  }
  return [version]::new(
    [int]$match.Groups[1].Value,
    [int]$match.Groups[2].Value,
    [int]$match.Groups[3].Value
  )
}

function Assert-MinimumVersion {
  param(
    [version]$Actual,
    [version]$Minimum,
    [string]$Name
  )

  if ($Actual -lt $Minimum) {
    throw "$Name $Actual is unsupported. Install $Name $Minimum or newer."
  }
}

function Normalize-PathForComparison {
  param([string]$PathValue)
  return [System.IO.Path]::GetFullPath($PathValue).TrimEnd("\", "/")
}

function Get-CodexInstallerCompatiblePath {
  param([string]$PathValue)

  if (-not ("CodexInstallerNativePaths" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CodexInstallerNativePaths {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint bufferLength);
}
"@
  }
  $buffer = [System.Text.StringBuilder]::new(32768)
  $length = [CodexInstallerNativePaths]::GetShortPathName($PathValue, $buffer, [uint32]$buffer.Capacity)
  if ($length -eq 0 -or $length -ge $buffer.Capacity) {
    return $PathValue
  }
  return $buffer.ToString()
}

function Find-MarketplaceRoot {
  param(
    [string]$MarketplaceList,
    [string]$Name
  )

  foreach ($line in ($MarketplaceList -split "`r?`n")) {
    $match = [regex]::Match($line, "^\s*" + [regex]::Escape($Name) + "\s+(.+?)\s*$")
    if ($match.Success) {
      return $match.Groups[1].Value
    }
  }
  return $null
}

function Add-PlanItem {
  param(
    [System.Collections.Generic.List[object]]$Plan,
    [string]$Step,
    [string]$Executable,
    [string[]]$Arguments
  )

  $Plan.Add([ordered]@{
      step = $Step
      executable = $Executable
      arguments = @($Arguments)
    })
}

function Invoke-InstallStep {
  param(
    [string]$Step,
    [string]$Executable,
    [string[]]$Arguments,
    [switch]$Capture,
    [switch]$HideOutput
  )

  $script:CurrentStep = $Step
  Write-InstallerMessage "[$($completedSteps.Count + 1)/$($script:TotalInstallSteps)] $Step"
  Write-ProgressState "running" $Step
  $output = Invoke-NativeCommand $Executable $Arguments -Capture:$Capture -HideOutput:$HideOutput
  $completedSteps.Add($Step)
  Write-ProgressState "running" "$Step completed"
  return $output
}

try {
  if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = Split-Path -Parent $PSScriptRoot
  }
  $RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path

  foreach ($requiredPath in @(
      "package.json",
      "package-lock.json",
      ".agents\plugins\marketplace.json",
      "plugins\codex-inter-agent-messaging\.codex-plugin\plugin.json",
      "scripts\build-plugin.mjs",
      "scripts\validate-plugin.mjs",
      "generated\codex\manifest.json"
    )) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepositoryRoot $requiredPath) -PathType Leaf)) {
      throw "Repository is incomplete; required file is missing: $requiredPath"
    }
  }
  $packageManifest = Get-Content -LiteralPath (Join-Path $RepositoryRoot "package.json") -Raw |
    ConvertFrom-Json
  $expectedVersion = [string]$packageManifest.version
  if ([string]::IsNullOrWhiteSpace($expectedVersion)) {
    throw "package.json does not contain a valid version."
  }
  $protocolManifest = Get-Content -LiteralPath (Join-Path $RepositoryRoot "generated\codex\manifest.json") -Raw |
    ConvertFrom-Json
  $supportedCodexVersion = (Get-SemanticVersion ([string]$protocolManifest.codexVersion) "supported Codex CLI").ToString()

  if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    $CodexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
      Join-Path $HOME ".codex"
    } else {
      $env:CODEX_HOME
    }
  }
  if (-not (Test-Path -LiteralPath $CodexHome -PathType Container)) {
    throw "The selected Codex data directory does not exist: $CodexHome"
  }
  $CodexHome = (Resolve-Path -LiteralPath $CodexHome).Path
  $env:CODEX_HOME = $CodexHome

  Push-Location -LiteralPath $RepositoryRoot
  $script:LocationPushed = $true

  $script:CurrentStep = "Check prerequisites"
  Write-InstallerMessage "Checking prerequisites..."
  Write-ProgressState "checking" "Checking prerequisites"
  $nodeCommand = Resolve-RequiredCommand "node" "Install Node.js 22.11 or newer, then run INSTALL.cmd again."
  $npmCommand = Resolve-RequiredCommand "npm.cmd" "Install npm 10.9 or newer with Node.js, then run INSTALL.cmd again."

  $nodeVersionText = Invoke-NativeCommand $nodeCommand @("--version") -Capture -HideOutput
  $npmVersionText = Invoke-NativeCommand $npmCommand @("--version") -Capture -HideOutput
  $nodeVersion = Get-SemanticVersion $nodeVersionText "Node.js"
  $npmVersion = Get-SemanticVersion $npmVersionText "npm"
  Assert-MinimumVersion $nodeVersion ([version]"22.11.0") "Node.js"
  Assert-MinimumVersion $npmVersion ([version]"10.9.0") "npm"

  $desktopPackage = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  $desktopDetected = $null -ne $desktopPackage
  $codexCommand = Resolve-PublicCodexCommand $CodexExecutable
  $codexInstallDirectory = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin"
  $codexInstallPlanned = $false
  $codexNeedsInstall = $null -eq $codexCommand
  if (-not $codexNeedsInstall) {
    $codexVersionText = Invoke-NativeCommand $codexCommand @("--version") -Capture -HideOutput
    $null = Invoke-NativeCommand $codexCommand @("plugin", "--help") -Capture -HideOutput
    $actualCodexVersion = (Get-SemanticVersion $codexVersionText "Codex CLI").ToString()
    if ($actualCodexVersion -ne $supportedCodexVersion) {
      if ($InstallCodexCli -and [string]::IsNullOrWhiteSpace($CodexExecutable)) {
        $codexNeedsInstall = $true
      } else {
        throw "Codex CLI $actualCodexVersion is incompatible with this plugin build. Select or install the supported Codex CLI $supportedCodexVersion."
      }
    }
  }
  if ($codexNeedsInstall) {
    if (-not $InstallCodexCli) {
      $desktopHint = if ($desktopDetected) {
        " The Codex desktop app is installed, but its packaged executable is not a public CLI."
      } else { "" }
      throw "A public Codex CLI was not found.$desktopHint Use the graphical installer's official CLI option, select a standalone codex.exe, or install the official Codex CLI."
    }
    if ($DryRun) {
      $codexInstallPlanned = $true
      $codexCommand = Join-Path $codexInstallDirectory "codex.exe"
      $codexVersionText = "planned official standalone install $supportedCodexVersion"
    } else {
      $script:TotalInstallSteps = 7
      Install-OfficialCodexCli $codexInstallDirectory $supportedCodexVersion
      $completedSteps.Add("Install official Codex CLI")
      $codexCommand = Resolve-PublicCodexCommand (Join-Path $codexInstallDirectory "codex.exe")
      if ($null -eq $codexCommand) {
        throw "The official Codex CLI installer completed, but no usable codex.exe was found in '$codexInstallDirectory'."
      }
    }
  }

  if (-not $codexInstallPlanned) {
    $codexVersionText = Invoke-NativeCommand $codexCommand @("--version") -Capture -HideOutput
    $null = Invoke-NativeCommand $codexCommand @("plugin", "--help") -Capture -HideOutput
    $actualCodexVersion = (Get-SemanticVersion $codexVersionText "Codex CLI").ToString()
    if ($actualCodexVersion -ne $supportedCodexVersion) {
      throw "Codex CLI $actualCodexVersion is incompatible after installation; expected $supportedCodexVersion."
    }
  }

  $configuredRoot = $null
  if (-not $codexInstallPlanned) {
    $marketplaceList = Invoke-NativeCommand $codexCommand @("plugin", "marketplace", "list") -Capture -HideOutput
    $configuredRoot = Find-MarketplaceRoot $marketplaceList $marketplaceName
  }
  if ($null -ne $configuredRoot) {
    $expectedRoot = Normalize-PathForComparison $RepositoryRoot
    $actualRoot = Normalize-PathForComparison $configuredRoot
    if (-not [string]::Equals($expectedRoot, $actualRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Marketplace '$marketplaceName' is already configured at '$configuredRoot'. Remove that marketplace explicitly or run its own installer; this wizard will not replace it with '$RepositoryRoot'."
    }
  }

  $globalPrefix = (Invoke-NativeCommand $npmCommand @("prefix", "--global") -Capture -HideOutput).Trim()
  if ([string]::IsNullOrWhiteSpace($globalPrefix)) {
    throw "npm returned an empty global prefix. Configure a writable user-level npm prefix and retry."
  }

  $plan = [System.Collections.Generic.List[object]]::new()
  if ($codexInstallPlanned) {
    Add-PlanItem $plan "Install official Codex CLI" "powershell.exe" @(
      "official-installer", $officialCodexInstallerUrl, "release", $supportedCodexVersion, "install-dir", $codexInstallDirectory
    )
  }
  Add-PlanItem $plan "Install locked dependencies" $npmCommand @("ci", "--no-audit", "--no-fund")
  Add-PlanItem $plan "Build relocatable plugin runtime" $npmCommand @("run", "plugin:build")
  Add-PlanItem $plan "Validate plugin package" $npmCommand @("run", "plugin:validate")
  Add-PlanItem $plan "Install companion CLI" $npmCommand @("install", "--global", $RepositoryRoot, "--no-audit", "--no-fund")
  Add-PlanItem $plan "Register repository marketplace" $codexCommand @("plugin", "marketplace", "add", $RepositoryRoot, "--json")
  Add-PlanItem $plan "Install or refresh Codex plugin" $codexCommand @("plugin", "add", $pluginSelector, "--json")

  if ($DryRun) {
    $result = [ordered]@{
      status = "passed"
      mode = "dry-run"
      repositoryRoot = $RepositoryRoot
      codexHome = $CodexHome
      codexExecutable = $codexCommand
      codexDesktopDetected = $desktopDetected
      supportedCodexVersion = $supportedCodexVersion
      officialCliInstallPlanned = $codexInstallPlanned
      marketplace = $marketplaceName
      marketplaceState = if ($codexInstallPlanned) {
        "check-after-cli-install"
      } elseif ($null -eq $configuredRoot) {
        "not-configured"
      } else {
        "same-path"
      }
      plugin = $pluginSelector
      versions = [ordered]@{
        node = $nodeVersion.ToString()
        npm = $npmVersion.ToString()
        codex = $codexVersionText.Trim()
      }
      npmGlobalPrefix = $globalPrefix
      commands = @($plan)
      changesMade = $false
    }
    Write-ProgressState "complete" "Dry run passed; no changes were made"
    if ($Json) {
      Write-Output ($result | ConvertTo-Json -Depth 6)
    } else {
      Write-Host ""
      Write-Host "Dry run passed. No changes were made."
      foreach ($item in $plan) {
        Write-Host " - $($item.step): $($item.executable) $($item.arguments -join ' ')"
      }
    }
    exit 0
  }

  $null = Invoke-InstallStep "Install locked dependencies" $npmCommand @("ci", "--no-audit", "--no-fund")
  $null = Invoke-InstallStep "Build relocatable plugin runtime" $npmCommand @("run", "plugin:build")
  $null = Invoke-InstallStep "Validate plugin package" $npmCommand @("run", "plugin:validate")
  $null = Invoke-InstallStep "Install companion CLI" $npmCommand @("install", "--global", $RepositoryRoot, "--no-audit", "--no-fund")
  $marketplaceAddOutput = Invoke-InstallStep "Register repository marketplace" $codexCommand @("plugin", "marketplace", "add", $RepositoryRoot, "--json") -Capture -HideOutput
  $pluginAddOutput = Invoke-InstallStep "Install or refresh Codex plugin" $codexCommand @("plugin", "add", $pluginSelector, "--json") -Capture -HideOutput

  $marketplaceResult = $marketplaceAddOutput | ConvertFrom-Json
  $pluginResult = $pluginAddOutput | ConvertFrom-Json
  $verifiedMarketplaceList = Invoke-NativeCommand $codexCommand @("plugin", "marketplace", "list") -Capture -HideOutput
  $verifiedMarketplaceRoot = Find-MarketplaceRoot $verifiedMarketplaceList $marketplaceName
  if ($null -eq $verifiedMarketplaceRoot -or -not [string]::Equals(
      (Normalize-PathForComparison $verifiedMarketplaceRoot),
      (Normalize-PathForComparison $RepositoryRoot),
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Codex did not report the expected marketplace after installation."
  }
  $pluginList = Invoke-NativeCommand $codexCommand @("plugin", "list") -Capture -HideOutput
  if ($pluginList -notmatch [regex]::Escape($pluginSelector) -or $pluginList -notmatch "installed, enabled") {
    throw "Codex did not report '$pluginSelector' as installed and enabled."
  }

  $cliCandidates = @(
    (Join-Path $globalPrefix "codex-inter-agent.cmd"),
    (Join-Path $globalPrefix "codex-inter-agent.exe"),
    (Join-Path (Join-Path $globalPrefix "bin") "codex-inter-agent")
  )
  $installedCli = $cliCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if ($null -eq $installedCli) {
    throw "The companion CLI was installed, but its executable was not found under npm global prefix '$globalPrefix'."
  }
  $installedCliVersion = Invoke-NativeCommand $installedCli @("--version") -Capture -HideOutput
  if ($installedCliVersion.Trim() -ne $expectedVersion) {
    throw "Installed CLI version '$($installedCliVersion.Trim())' does not match repository version '$expectedVersion'."
  }

  $result = [ordered]@{
    status = "passed"
    mode = "install"
    repositoryRoot = $RepositoryRoot
    codexHome = $CodexHome
    codexExecutable = $codexCommand
      codexDesktopDetected = $desktopDetected
      supportedCodexVersion = $supportedCodexVersion
    marketplace = $marketplaceName
    marketplaceAlreadyAdded = [bool]$marketplaceResult.alreadyAdded
    plugin = $pluginSelector
    pluginVersion = [string]$pluginResult.version
    pluginInstalledPath = [string]$pluginResult.installedPath
    cliPath = $installedCli
    cliVersion = $installedCliVersion.Trim()
    codexVersion = $codexVersionText.Trim()
    completedSteps = @($completedSteps)
    nextSteps = @(
      "Restart Codex or open a new task so it discovers the plugin tools.",
      "Set a trusted BRIDGE_AGENT_ID before launching each participating agent.",
      "Register agent IDs and use codex-inter-agent connect for supported shared-owner threads."
    )
  }

  if ($Json) {
    Write-Output ($result | ConvertTo-Json -Depth 6)
  } else {
    Write-Host ""
    Write-Host "Installation complete." -ForegroundColor Green
    Write-Host "Plugin: $pluginSelector ($($result.pluginVersion))"
    Write-Host "CLI: $($result.cliVersion)"
    Write-Host ""
    Write-Host "Next steps:"
    foreach ($nextStep in $result.nextSteps) {
      Write-Host " - $nextStep"
    }
  }
  Write-ProgressState "complete" "Installation completed successfully" $completedSteps.Count
  exit 0
} catch {
  $failure = [ordered]@{
    status = "failed"
    mode = if ($DryRun) { "dry-run" } else { "install" }
    step = $script:CurrentStep
    error = $_.Exception.Message
  }
  if ($Json) {
    Write-Output ($failure | ConvertTo-Json -Depth 4)
  } else {
    Write-Host ""
    Write-Host "Installation failed during: $($script:CurrentStep)" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "See docs\TROUBLESHOOTING.md or run INSTALL.cmd -DryRun for diagnostics."
  }
  Write-ProgressState "failed" $_.Exception.Message $completedSteps.Count
  exit 1
} finally {
  if ($script:LocationPushed) {
    Pop-Location
  }
  $env:CODEX_HOME = $script:OriginalCodexHome
}
