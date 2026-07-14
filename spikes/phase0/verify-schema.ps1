[CmdletBinding()]
param(
    [string]$SchemaRoot
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($SchemaRoot)) {
    $SchemaRoot = Join-Path $PSScriptRoot 'generated\app-server-schema'
}
$failures = [System.Collections.Generic.List[string]]::new()
$passes = [System.Collections.Generic.List[string]]::new()

function Test-RawContains {
    param(
        [string]$RelativePath,
        [string]$Needle,
        [string]$Label
    )

    $path = Join-Path $SchemaRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path)) {
        $failures.Add("${Label}: missing file $RelativePath")
        return
    }

    $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $path
    if ($raw.Contains($Needle)) {
        $passes.Add("$Label ($RelativePath)")
    } else {
        $failures.Add("${Label}: missing '$Needle' in $RelativePath")
    }
}

function Get-SchemaJson {
    param([string]$RelativePath)
    $path = Join-Path $SchemaRoot $RelativePath
    return Get-Content -Raw -Encoding UTF8 -LiteralPath $path | ConvertFrom-Json
}

Test-RawContains 'ClientRequest.json' '"initialize"' 'initialize request'
Test-RawContains 'ClientNotification.json' '"initialized"' 'initialized notification'
Test-RawContains 'ClientRequest.json' '"thread/list"' 'thread/list request'
Test-RawContains 'ClientRequest.json' '"thread/search"' 'thread/search request'
Test-RawContains 'ClientRequest.json' '"thread/read"' 'thread/read request'
Test-RawContains 'ClientRequest.json' '"thread/resume"' 'thread/resume request'
Test-RawContains 'ClientRequest.json' '"turn/start"' 'turn/start request'
Test-RawContains 'ClientRequest.json' '"turn/interrupt"' 'turn/interrupt request'
Test-RawContains 'ServerNotification.json' '"item/completed"' 'item/completed notification'
Test-RawContains 'ServerNotification.json' '"turn/completed"' 'turn/completed notification'
Test-RawContains 'ServerNotification.json' '"thread/status/changed"' 'thread/status/changed notification'

$turnStart = Get-SchemaJson 'v2\TurnStartParams.json'
if ($turnStart.properties.PSObject.Properties.Name -contains 'clientUserMessageId') {
    $passes.Add('clientUserMessageId on v2 TurnStartParams')
} else {
    $failures.Add('clientUserMessageId missing from v2 TurnStartParams')
}

$threadStart = Get-SchemaJson 'v2\ThreadStartParams.json'
if ($threadStart.properties.PSObject.Properties.Name -contains 'dynamicTools') {
    $passes.Add('dynamicTools on v2 ThreadStartParams')
} else {
    $failures.Add('dynamicTools missing from v2 ThreadStartParams')
}

$threadResume = Get-SchemaJson 'v2\ThreadResumeParams.json'
if ($threadResume.properties.PSObject.Properties.Name -notcontains 'dynamicTools') {
    $passes.Add('dynamicTools absent from v2 ThreadResumeParams')
} else {
    $failures.Add('dynamicTools unexpectedly present on v2 ThreadResumeParams')
}

$resumeResponse = Get-SchemaJson 'v2\ThreadResumeResponse.json'
$threadProperties = $resumeResponse.definitions.Thread.properties.PSObject.Properties.Name
if ($threadProperties -contains 'status') {
    $passes.Add('Thread.status available in resume response')
} else {
    $failures.Add('Thread.status missing from resume response')
}

$statusVariants = @(
    $resumeResponse.definitions.ThreadStatus.oneOf |
        ForEach-Object { $_.properties.type.enum } |
        Where-Object { $_ }
)
$expectedStatuses = @('notLoaded', 'idle', 'systemError', 'active')
foreach ($status in $expectedStatuses) {
    if ($statusVariants -contains $status) {
        $passes.Add("Thread.status variant '$status'")
    } else {
        $failures.Add("Thread.status variant '$status' missing")
    }
}

$activeFlags = @($resumeResponse.definitions.ThreadActiveFlag.enum)
foreach ($flag in @('waitingOnApproval', 'waitingOnUserInput')) {
    if ($activeFlags -contains $flag) {
        $passes.Add("Thread active flag '$flag'")
    } else {
        $failures.Add("Thread active flag '$flag' missing")
    }
}

$turnStatuses = @($resumeResponse.definitions.TurnStatus.enum)
foreach ($status in @('completed', 'interrupted', 'failed', 'inProgress')) {
    if ($turnStatuses -contains $status) {
        $passes.Add("Turn.status value '$status'")
    } else {
        $failures.Add("Turn.status value '$status' missing")
    }
}

$passes | ForEach-Object { Write-Output "PASS $_" }
if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error "FAIL $_" }
    exit 1
}

Write-Output "Verified $($passes.Count) required protocol facts."
