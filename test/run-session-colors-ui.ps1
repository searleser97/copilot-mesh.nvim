param(
  [Parameter(Mandatory)][string]$LualineRoot,
  [Parameter(Mandatory)][string]$NvimConfig,
  [string]$PluginRoot = (Split-Path $PSScriptRoot),
  [switch]$Mcp,
  [string]$ArtifactRoot = (Join-Path (Split-Path $PSScriptRoot) ".e2e-artifacts\session-colors-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))")
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $ArtifactRoot | Out-Null
$registry = Join-Path $ArtifactRoot 'colors.sqlite'
function Start-Case([string]$Name, [string]$Session, [string]$Mode = '') {
  $workspace = Join-Path $ArtifactRoot $Name
  New-Item -ItemType Directory -Path $workspace | Out-Null
  $info = [Diagnostics.ProcessStartInfo]::new('nvim')
  $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.WorkingDirectory = $workspace
  foreach ($argument in @('--headless', '-u', 'NONE', '-l', (Join-Path $PSScriptRoot 'session-colors-ui.lua'))) {
    $info.ArgumentList.Add($argument)
  }
  $variables = @{
    MESH_PLUGIN_ROOT = $PluginRoot
    MESH_LUALINE_ROOT = $LualineRoot
    MESH_NVIM_CONFIG = $NvimConfig
    MESH_TEST_WORKSPACE = $workspace
    MESH_TEST_DATABASE = (Join-Path $workspace 'core.sqlite')
    MESH_TEST_COLORS = $registry
    MESH_TEST_SESSION = $Session
    MESH_TEST_MCP = $(if ($Mode) { $Mode } elseif ($Mcp) { '1' } else { '0' })
    MESH_TEST_RESULT = (Join-Path $workspace 'result.json')
    NATIVE_COPILOT_E2E_PROFILE = 'allow-all'
  }
  foreach ($entry in $variables.GetEnumerator()) { $info.Environment[$entry.Key] = $entry.Value }
  $process = [Diagnostics.Process]::Start($info)
  return @{
    Process = $process
    Output = $process.StandardOutput.ReadToEndAsync()
    Error = $process.StandardError.ReadToEndAsync()
    Workspace = $workspace
  }
}
function Complete-Case($Case) {
  if (!$Case.Process.WaitForExit(60000)) {
    $Case.Process.Kill($true)
    throw "Isolated Neovim timed out: $($Case.Workspace)"
  }
  $text = $Case.Output.Result + $Case.Error.Result
  Set-Content -LiteralPath (Join-Path $Case.Workspace 'output.txt') -Value $text
  if ($Case.Process.ExitCode -ne 0) { throw $text }
  return Get-Content -Raw (Join-Path $Case.Workspace 'result.json') | ConvertFrom-Json
}
$first = Start-Case 'first' 'new'
$second = Start-Case 'second' 'e2e-cli-session'
if ($Mcp) { $watcher = Start-Case 'same-session-window' 'e2e-cli-session' 'watch' }
$a = Complete-Case $first
$b = Complete-Case $second
if ($Mcp) { $null = Complete-Case $watcher }
if ($a.identity.bg -eq $b.identity.bg) { throw 'Distinct main sessions received the same color' }
$restored = Complete-Case (Start-Case 'restored-other-workspace' 'e2e-cli-session' '0')
if ($restored.identity.bg -ne $b.identity.bg) { throw 'Restored conversation lost its color' }
Write-Output "PASS independent Neovim adapters, new/resume identities, active/inactive actual lualine and cross-workspace restoration. Artifacts: $ArtifactRoot"
