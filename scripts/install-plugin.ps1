[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Json,
  [string]$RepositoryRoot
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
$completedSteps = [System.Collections.Generic.List[string]]::new()

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
  Write-InstallerMessage "[$($completedSteps.Count + 1)/6] $Step"
  $output = Invoke-NativeCommand $Executable $Arguments -Capture:$Capture -HideOutput:$HideOutput
  $completedSteps.Add($Step)
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
      "scripts\validate-plugin.mjs"
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

  Push-Location -LiteralPath $RepositoryRoot
  $script:LocationPushed = $true

  $script:CurrentStep = "Check prerequisites"
  Write-InstallerMessage "Checking prerequisites..."
  $nodeCommand = Resolve-RequiredCommand "node" "Install Node.js 22.11 or newer, then run INSTALL.cmd again."
  $npmCommand = Resolve-RequiredCommand "npm.cmd" "Install npm 10.9 or newer with Node.js, then run INSTALL.cmd again."
  $codexCommand = Resolve-RequiredCommand "codex" "Install or update Codex CLI, then run INSTALL.cmd again."

  $nodeVersionText = Invoke-NativeCommand $nodeCommand @("--version") -Capture -HideOutput
  $npmVersionText = Invoke-NativeCommand $npmCommand @("--version") -Capture -HideOutput
  $codexVersionText = Invoke-NativeCommand $codexCommand @("--version") -Capture -HideOutput
  $null = Invoke-NativeCommand $codexCommand @("plugin", "--help") -Capture -HideOutput
  $nodeVersion = Get-SemanticVersion $nodeVersionText "Node.js"
  $npmVersion = Get-SemanticVersion $npmVersionText "npm"
  Assert-MinimumVersion $nodeVersion ([version]"22.11.0") "Node.js"
  Assert-MinimumVersion $npmVersion ([version]"10.9.0") "npm"

  $marketplaceList = Invoke-NativeCommand $codexCommand @("plugin", "marketplace", "list") -Capture -HideOutput
  $configuredRoot = Find-MarketplaceRoot $marketplaceList $marketplaceName
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
      marketplace = $marketplaceName
      marketplaceState = if ($null -eq $configuredRoot) { "not-configured" } else { "same-path" }
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
  exit 1
} finally {
  if ($script:LocationPushed) {
    Pop-Location
  }
}
