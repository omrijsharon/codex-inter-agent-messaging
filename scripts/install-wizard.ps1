[CmdletBinding()]
param(
  [string]$RepositoryRoot,
  [switch]$TestMode,
  [ValidateSet("none", "success", "failure")]
  [string]$TestOutcome = "none",
  [switch]$AutoStart,
  [int]$AutoCloseMilliseconds = 0,
  [string]$ReportPath,
  [switch]$HideConsole
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.Windows.Forms

if ($HideConsole) {
  if (-not ("InstallerConsoleWindow" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class InstallerConsoleWindow {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
}
"@
  }
  $consoleWindow = [InstallerConsoleWindow]::GetConsoleWindow()
  if ($consoleWindow -ne [IntPtr]::Zero) {
    [InstallerConsoleWindow]::ShowWindow($consoleWindow, 0) | Out-Null
  }
}

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Split-Path -Parent $PSScriptRoot
}
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$backend = Join-Path $RepositoryRoot "scripts\install-plugin.ps1"
$protocolManifestPath = Join-Path $RepositoryRoot "generated\codex\manifest.json"
if (-not (Test-Path -LiteralPath $backend -PathType Leaf)) {
  [System.Windows.MessageBox]::Show(
    "The installer backend is missing. Download the complete repository and try again.",
    "Codex Inter-Agent Messaging",
    [System.Windows.MessageBoxButton]::OK,
    [System.Windows.MessageBoxImage]::Error
  ) | Out-Null
  exit 1
}
$protocolManifest = Get-Content -LiteralPath $protocolManifestPath -Raw | ConvertFrom-Json
$supportedCodexMatch = [regex]::Match([string]$protocolManifest.codexVersion, "(\d+\.\d+\.\d+)")
if (-not $supportedCodexMatch.Success) { throw "The supported Codex CLI version is missing from the protocol manifest." }
$supportedCodexVersion = $supportedCodexMatch.Groups[1].Value

function Normalize-InstallerPath {
  param([string]$PathValue)
  return [System.IO.Path]::GetFullPath($PathValue).TrimEnd("\", "/")
}

function Test-PrivateCodexExecutable {
  param([string]$PathValue)
  $normalized = Normalize-InstallerPath $PathValue
  return $normalized -match "(?i)\\WindowsApps\\OpenAI\.Codex_.*\\app\\resources\\codex\.exe$" -or
    $normalized -match "(?i)\\\.vscode\\extensions\\openai\.chatgpt-[^\\]+\\bin\\.*\\codex\.exe$"
}

function Find-PublicCodexExecutable {
  $candidate = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $candidate -and -not (Test-PrivateCodexExecutable $candidate.Source)) {
    return $candidate.Source
  }
  $standalone = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin\codex.exe"
  if (Test-Path -LiteralPath $standalone -PathType Leaf) {
    return $standalone
  }
  return $null
}

function Quote-ProcessArgument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

$publicCodex = Find-PublicCodexExecutable
$incompatibleCodex = $null
if ($null -ne $publicCodex) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $versionOutput = (& $publicCodex --version 2>&1) -join "`n"
    $versionExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $versionMatch = [regex]::Match($versionOutput, "(\d+\.\d+\.\d+)")
  if ($versionExit -ne 0 -or -not $versionMatch.Success -or $versionMatch.Groups[1].Value -ne $supportedCodexVersion) {
    $incompatibleCodex = $publicCodex
    $publicCodex = $null
  }
}
$standaloneCodex = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin\codex.exe"
$desktopPackage = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue |
  Select-Object -First 1
$desktopDetected = $null -ne $desktopPackage
$defaultCodexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
  Join-Path $HOME ".codex"
} else {
  $env:CODEX_HOME
}

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Codex Inter-Agent Messaging Setup" Height="600" Width="780"
        WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
        Background="#F7F8FA" FontFamily="Segoe UI" ShowInTaskbar="True">
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="Padding" Value="20,9"/>
      <Setter Property="MinWidth" Value="105"/>
      <Setter Property="Cursor" Value="Hand"/>
    </Style>
    <Style TargetType="TextBox">
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="Padding" Value="10,8"/>
      <Setter Property="BorderBrush" Value="#CBD5E1"/>
      <Setter Property="BorderThickness" Value="1"/>
    </Style>
  </Window.Resources>
  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="122"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="72"/>
    </Grid.RowDefinitions>

    <Border Grid.Row="0" Background="#111827">
      <Grid Margin="34,20">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="70"/>
          <ColumnDefinition Width="*"/>
        </Grid.ColumnDefinitions>
        <Border Width="54" Height="54" CornerRadius="27" Background="#2563EB" VerticalAlignment="Center">
          <TextBlock Text="&lt;-&gt;" Foreground="White" FontSize="18" FontWeight="SemiBold"
                     HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <StackPanel Grid.Column="1" VerticalAlignment="Center">
          <TextBlock Text="Codex Inter-Agent Messaging" Foreground="White" FontSize="25" FontWeight="SemiBold"/>
          <TextBlock Text="Setup Wizard" Foreground="#A7B4C8" FontSize="14" Margin="0,5,0,0"/>
        </StackPanel>
      </Grid>
    </Border>

    <Grid Grid.Row="1" Margin="38,26,38,18">
      <Grid x:Name="SetupPanel">
        <StackPanel>
          <TextBlock Text="Ready to install" FontSize="22" FontWeight="SemiBold" Foreground="#111827"/>
          <TextBlock Text="Choose the Codex installation settings used by the desktop app."
                     FontSize="13" Foreground="#526071" Margin="0,5,0,18"/>

          <Border x:Name="DetectionCard" Background="#EFF6FF" BorderBrush="#BFDBFE" BorderThickness="1" CornerRadius="6" Padding="12" Margin="0,0,0,17">
            <TextBlock x:Name="DetectionText" Foreground="#1E3A5F" FontSize="13" TextWrapping="Wrap"/>
          </Border>

          <TextBlock Text="Codex CLI executable" FontSize="13" FontWeight="SemiBold" Foreground="#243142"/>
          <Grid Margin="0,6,0,5">
            <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="92"/></Grid.ColumnDefinitions>
            <TextBox x:Name="CodexExecutableText" VerticalContentAlignment="Center"/>
            <Button x:Name="BrowseCodexButton" Grid.Column="1" Content="Browse..." Margin="8,0,0,0" Padding="8,7" MinWidth="80"/>
          </Grid>
          <TextBlock Text="Select a standalone codex.exe, not the private file inside WindowsApps or an editor extension."
                     FontSize="11.5" Foreground="#64748B" Margin="1,0,0,13"/>

          <TextBlock Text="Codex data directory" FontSize="13" FontWeight="SemiBold" Foreground="#243142"/>
          <Grid Margin="0,6,0,5">
            <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="92"/></Grid.ColumnDefinitions>
            <TextBox x:Name="CodexHomeText" VerticalContentAlignment="Center"/>
            <Button x:Name="BrowseHomeButton" Grid.Column="1" Content="Browse..." Margin="8,0,0,0" Padding="8,7" MinWidth="80"/>
          </Grid>
          <TextBlock Text="The Windows Codex app normally uses %USERPROFILE%\.codex. The folder must already exist."
                     FontSize="11.5" Foreground="#64748B" Margin="1,0,0,11"/>

          <CheckBox x:Name="InstallCodexCheck" FontSize="13" Foreground="#243142" VerticalContentAlignment="Center">
            <TextBlock Text="Install the official standalone Codex CLI if it is missing"/>
          </CheckBox>
          <TextBlock Text="Uses OpenAI's official Windows installer and the standard per-user install location."
                     FontSize="11.5" Foreground="#64748B" Margin="22,4,0,0"/>
        </StackPanel>
      </Grid>

      <Grid x:Name="ProgressPanel" Visibility="Collapsed">
        <StackPanel VerticalAlignment="Center">
          <TextBlock Text="Installing the plugin" HorizontalAlignment="Center" FontSize="23" FontWeight="SemiBold" Foreground="#111827"/>
          <TextBlock x:Name="ProgressStatus" Text="Preparing installation..." HorizontalAlignment="Center" FontSize="14" Foreground="#526071" Margin="0,12,0,22"/>
          <ProgressBar x:Name="InstallProgress" Height="8" IsIndeterminate="True" Foreground="#2563EB"/>
          <TextBlock Text="This can take a few minutes. You can continue using other applications."
                     HorizontalAlignment="Center" FontSize="12" Foreground="#64748B" Margin="0,18,0,0"/>
        </StackPanel>
      </Grid>

      <Grid x:Name="FinishPanel" Visibility="Collapsed">
        <StackPanel VerticalAlignment="Center">
          <Border x:Name="FinishIcon" Width="64" Height="64" CornerRadius="32" Background="#DCFCE7" HorizontalAlignment="Center">
            <TextBlock x:Name="FinishGlyph" Text="OK" Foreground="#16803A" FontSize="19" FontWeight="SemiBold" HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <TextBlock x:Name="FinishTitle" Text="Installation complete" HorizontalAlignment="Center" FontSize="23" FontWeight="SemiBold" Foreground="#111827" Margin="0,16,0,0"/>
          <TextBlock x:Name="FinishMessage" Text="Open a new Codex task to load the inter-agent messaging tools."
                     HorizontalAlignment="Center" TextAlignment="Center" TextWrapping="Wrap" MaxWidth="600" FontSize="14" Foreground="#526071" Margin="0,9,0,0"/>
          <TextBox x:Name="FailureDetails" Visibility="Collapsed" IsReadOnly="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto"
                   Height="104" Margin="0,18,0,0" Background="#FFF7F7" BorderBrush="#F4B4B4"/>
        </StackPanel>
      </Grid>
    </Grid>

    <Border Grid.Row="2" Background="White" BorderBrush="#E2E8F0" BorderThickness="0,1,0,0">
      <Grid Margin="38,0">
        <TextBlock x:Name="FooterHint" Text="No administrator privileges are required." Foreground="#64748B" FontSize="12" VerticalAlignment="Center"/>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
          <Button x:Name="CancelButton" Content="Cancel" Margin="0,0,10,0"/>
          <Button x:Name="InstallButton" Content="Install" Background="#2563EB" Foreground="White" BorderBrush="#1D4ED8" FontWeight="SemiBold"/>
        </StackPanel>
      </Grid>
    </Border>
  </Grid>
</Window>
"@

$reader = [System.Xml.XmlNodeReader]::new($xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)
$SetupPanel = $window.FindName("SetupPanel")
$ProgressPanel = $window.FindName("ProgressPanel")
$FinishPanel = $window.FindName("FinishPanel")
$DetectionText = $window.FindName("DetectionText")
$CodexExecutableText = $window.FindName("CodexExecutableText")
$CodexHomeText = $window.FindName("CodexHomeText")
$InstallCodexCheck = $window.FindName("InstallCodexCheck")
$BrowseCodexButton = $window.FindName("BrowseCodexButton")
$BrowseHomeButton = $window.FindName("BrowseHomeButton")
$ProgressStatus = $window.FindName("ProgressStatus")
$InstallProgress = $window.FindName("InstallProgress")
$FinishIcon = $window.FindName("FinishIcon")
$FinishGlyph = $window.FindName("FinishGlyph")
$FinishTitle = $window.FindName("FinishTitle")
$FinishMessage = $window.FindName("FinishMessage")
$FailureDetails = $window.FindName("FailureDetails")
$FooterHint = $window.FindName("FooterHint")
$CancelButton = $window.FindName("CancelButton")
$InstallButton = $window.FindName("InstallButton")

$CodexExecutableText.Text = if ($null -eq $publicCodex) { $standaloneCodex } else { $publicCodex }
$CodexHomeText.Text = $defaultCodexHome
$InstallCodexCheck.IsChecked = $null -eq $publicCodex
$DetectionText.Text = if ($null -ne $publicCodex) {
  "Public Codex CLI detected. The wizard will validate it before making changes."
} elseif ($desktopDetected) {
  if ($null -ne $incompatibleCodex) {
    "Codex desktop app detected. The public CLI does not match supported version $supportedCodexVersion, so the compatible official CLI will be installed."
  } else {
    "Codex desktop app detected. Its private packaged binary cannot be used by external installers, so the compatible official CLI $supportedCodexVersion will also be installed."
  }
} else {
  "No public Codex CLI was detected. The wizard can install the official standalone CLI before installing the plugin."
}

$script:State = "setup"
$script:BackendProcess = $null
$script:Timer = $null
$script:TestTimer = $null
$script:CloseTimer = $null
$script:TemporaryDirectory = $null
$script:ProgressPath = $null
$script:ExitCode = 0

function Write-TestReport {
  if ([string]::IsNullOrWhiteSpace($ReportPath)) { return }
  $report = [ordered]@{
    title = $window.Title
    state = $script:State
    desktopDetected = $desktopDetected
    publicCodexDetected = $null -ne $publicCodex
    incompatibleCodexDetected = $null -ne $incompatibleCodex
    supportedCodexVersion = $supportedCodexVersion
    codexExecutable = $CodexExecutableText.Text
    codexHome = $CodexHomeText.Text
    installOfficialCli = [bool]$InstallCodexCheck.IsChecked
    setupVisible = $SetupPanel.Visibility.ToString()
    progressVisible = $ProgressPanel.Visibility.ToString()
    finishVisible = $FinishPanel.Visibility.ToString()
    finishTitle = $FinishTitle.Text
    failureDetailsVisible = $FailureDetails.Visibility.ToString()
  }
  [System.IO.File]::WriteAllText(
    $ReportPath,
    ($report | ConvertTo-Json -Depth 4),
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Show-FinishState {
  param(
    [bool]$Succeeded,
    [string]$Message,
    [string]$Details = ""
  )
  $script:State = if ($Succeeded) { "complete" } else { "failed" }
  $script:ExitCode = if ($Succeeded) { 0 } else { 1 }
  $SetupPanel.Visibility = "Collapsed"
  $ProgressPanel.Visibility = "Collapsed"
  $FinishPanel.Visibility = "Visible"
  $InstallButton.Content = "Close"
  $InstallButton.IsEnabled = $true
  $CancelButton.Visibility = "Collapsed"
  $FooterHint.Text = if ($Succeeded) { "The plugin is installed for the selected Codex data directory." } else { "No hidden recovery or history changes were attempted." }
  if ($Succeeded) {
    $FinishIcon.Background = "#DCFCE7"
    $FinishGlyph.Text = "OK"
    $FinishGlyph.Foreground = "#16803A"
    $FinishTitle.Text = "Installation complete"
    $FinishMessage.Text = $Message
    $FailureDetails.Visibility = "Collapsed"
  } else {
    $FinishIcon.Background = "#FEE2E2"
    $FinishGlyph.Text = "!"
    $FinishGlyph.Foreground = "#B91C1C"
    $FinishTitle.Text = "Installation could not be completed"
    $FinishMessage.Text = $Message
    $FailureDetails.Text = $Details
    $FailureDetails.Visibility = "Visible"
  }
  Write-TestReport
}

$BrowseCodexButton.Add_Click({
  $dialog = [Microsoft.Win32.OpenFileDialog]::new()
  $dialog.Title = "Select the standalone Codex CLI executable"
  $dialog.Filter = "Codex CLI (codex.exe)|codex.exe|Executable files (*.exe)|*.exe|All files (*.*)|*.*"
  $dialog.CheckFileExists = $true
  if ($dialog.ShowDialog($window)) {
    $CodexExecutableText.Text = $dialog.FileName
    $InstallCodexCheck.IsChecked = $false
  }
})

$BrowseHomeButton.Add_Click({
  $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
  $dialog.Description = "Select the existing Codex data directory"
  $dialog.SelectedPath = $CodexHomeText.Text
  $dialog.ShowNewFolderButton = $true
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $CodexHomeText.Text = $dialog.SelectedPath
  }
})

function Start-Installation {
  if ($script:State -in @("complete", "failed")) {
    $window.Close()
    return
  }
  if (-not (Test-Path -LiteralPath $CodexHomeText.Text -PathType Container)) {
    [System.Windows.MessageBox]::Show(
      $window,
      "Select an existing Codex data directory. The Windows app normally uses $HOME\.codex.",
      "Codex data directory",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Warning
    ) | Out-Null
    return
  }
  $selectedCodexExists = Test-Path -LiteralPath $CodexExecutableText.Text -PathType Leaf
  if (-not $selectedCodexExists -and -not [bool]$InstallCodexCheck.IsChecked) {
    [System.Windows.MessageBox]::Show(
      $window,
      "Select a standalone codex.exe or enable the official Codex CLI installation option.",
      "Codex CLI required",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Warning
    ) | Out-Null
    return
  }
  if ($selectedCodexExists -and (Test-PrivateCodexExecutable $CodexExecutableText.Text)) {
    [System.Windows.MessageBox]::Show(
      $window,
      "That codex.exe is private to WindowsApps or an editor extension. Select a standalone CLI or use the official installation option.",
      "Unsupported Codex executable",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Warning
    ) | Out-Null
    return
  }

  $script:State = "installing"
  $SetupPanel.Visibility = "Collapsed"
  $ProgressPanel.Visibility = "Visible"
  $FinishPanel.Visibility = "Collapsed"
  $InstallButton.IsEnabled = $false
  $CancelButton.IsEnabled = $false
  $FooterHint.Text = "Installation is running with your current user permissions."
  Write-TestReport

  if ($TestMode) {
    $script:TestTimer = [Windows.Threading.DispatcherTimer]::new()
    $script:TestTimer.Interval = [TimeSpan]::FromMilliseconds(350)
    $script:TestTimer.Add_Tick({
      $script:TestTimer.Stop()
      if ($TestOutcome -eq "failure") {
        Show-FinishState $false "The test installer reported an expected failure." "TEST_BACKEND_FAILURE: No system changes were made."
      } else {
        Show-FinishState $true "Test mode completed successfully. No system changes were made."
      }
    })
    $script:TestTimer.Start()
    return
  }

  $script:TemporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-inter-agent-gui-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $script:TemporaryDirectory | Out-Null
  $stdoutPath = Join-Path $script:TemporaryDirectory "result.json"
  $stderrPath = Join-Path $script:TemporaryDirectory "stderr.txt"
  $script:ProgressPath = Join-Path $script:TemporaryDirectory "progress.json"
  $arguments = [System.Collections.Generic.List[string]]::new()
  foreach ($value in @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $backend, "-Json", "-RepositoryRoot", $RepositoryRoot, "-CodexHome", $CodexHomeText.Text, "-ProgressPath", $script:ProgressPath)) {
    $arguments.Add((Quote-ProcessArgument $value))
  }
  if ([bool]$InstallCodexCheck.IsChecked) {
    $arguments.Add((Quote-ProcessArgument "-InstallCodexCli"))
  } elseif ($selectedCodexExists) {
    $arguments.Add((Quote-ProcessArgument "-CodexExecutable"))
    $arguments.Add((Quote-ProcessArgument $CodexExecutableText.Text))
  }

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = "powershell.exe"
  $startInfo.Arguments = $arguments -join " "
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $script:BackendProcess = [System.Diagnostics.Process]::new()
  $script:BackendProcess.StartInfo = $startInfo
  if (-not $script:BackendProcess.Start()) {
    Show-FinishState $false "The installer backend could not be started." "PowerShell did not start the backend process."
    return
  }

  $script:Timer = [Windows.Threading.DispatcherTimer]::new()
  $script:Timer.Interval = [TimeSpan]::FromMilliseconds(350)
  $script:Timer.Add_Tick({
    if (Test-Path -LiteralPath $script:ProgressPath -PathType Leaf) {
      try {
        $progress = Get-Content -LiteralPath $script:ProgressPath -Raw | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$progress.message)) {
          $ProgressStatus.Text = [string]$progress.message
        }
      } catch { }
    }
    if (-not $script:BackendProcess.HasExited) { return }
    $script:Timer.Stop()
    $stdout = $script:BackendProcess.StandardOutput.ReadToEnd()
    $stderr = $script:BackendProcess.StandardError.ReadToEnd()
    try {
      $result = $stdout | ConvertFrom-Json
    } catch {
      $result = $null
    }
    if ($script:BackendProcess.ExitCode -eq 0 -and $null -ne $result -and $result.status -eq "passed") {
      Show-FinishState $true "Open a new Codex task to load the inter-agent messaging tools."
    } else {
      $step = if ($null -ne $result -and $null -ne $result.step) { [string]$result.step } else { "Unknown step" }
      $detail = if ($null -ne $result -and $null -ne $result.error) { [string]$result.error } else { ($stdout + "`n" + $stderr).Trim() }
      Show-FinishState $false "The setup stopped during: $step" $detail
    }
  })
  $script:Timer.Start()
}

$InstallButton.Add_Click({ Start-Installation })
$CancelButton.Add_Click({
  $script:State = "cancelled"
  $script:ExitCode = 2
  Write-TestReport
  $window.Close()
})

$window.Add_Closing({
  if ($null -ne $script:BackendProcess -and -not $script:BackendProcess.HasExited) {
    $_.Cancel = $true
    return
  }
  if ($script:State -eq "setup") { $script:State = "cancelled"; $script:ExitCode = 2 }
  Write-TestReport
  if ($null -ne $script:TemporaryDirectory) {
    Remove-Item -LiteralPath $script:TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
})

$window.Add_ContentRendered({
  Write-TestReport
  if ($AutoStart) {
    $window.Dispatcher.BeginInvoke([Action]{ Start-Installation }) | Out-Null
  }
  if ($AutoCloseMilliseconds -gt 0) {
    $script:CloseTimer = [Windows.Threading.DispatcherTimer]::new()
    $script:CloseTimer.Interval = [TimeSpan]::FromMilliseconds($AutoCloseMilliseconds)
    $script:CloseTimer.Add_Tick({ $script:CloseTimer.Stop(); $window.Close() })
    $script:CloseTimer.Start()
  }
})

$null = $window.ShowDialog()
exit $script:ExitCode
