# Quits Claude Desktop, adds the fx-rfq server to its config while it is closed, and relaunches it.
# Must run outside Claude's process tree (anything Claude started dies with it), e.g. from a normal
# PowerShell window, or via WMI as Claude Code does:
#   Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell -NoProfile -ExecutionPolicy Bypass -File D:\code\mcp-apps-ui\scripts\restart-claude-with-fx-rfq.ps1' }
param([int]$DelaySeconds = 15)

$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $PSScriptRoot "last-claude-install.log"
function Log($msg) { "$(Get-Date -Format HH:mm:ss) $msg" | Out-File $log -Append -Encoding utf8 }

"" | Out-File $log -Encoding utf8
Log "started, waiting $DelaySeconds s"
Start-Sleep -Seconds $DelaySeconds

Get-Process -Name claude -ErrorAction SilentlyContinue | Stop-Process -Force
for ($i = 0; $i -lt 30 -and (Get-Process -Name claude -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
Log "claude stopped: $(-not (Get-Process -Name claude -ErrorAction SilentlyContinue))"
Start-Sleep -Seconds 2

Set-Location $root
& "C:\Program Files\nodejs\node.exe" (Join-Path $PSScriptRoot "add-to-claude-desktop.cjs") 2>&1 | ForEach-Object { Log $_ }

$pkg = Get-AppxPackage -Name "*Claude*" | Select-Object -First 1
if ($pkg) { Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!Claude" } else { Start-Process "$env:LOCALAPPDATA\AnthropicClaude\claude.exe" }
Log "relaunched"
