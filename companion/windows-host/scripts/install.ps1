$ErrorActionPreference = "Stop"

Write-Host "WFL Windows Host installs for the current Windows user only."
Write-Host "It creates no inbound firewall rule, service, scheduled task, or administrator shell."
$confirmation = Read-Host "Type INSTALL to continue"
if ($confirmation -ne "INSTALL") {
  Write-Host "Installation cancelled."
  exit 1
}

$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0) {
  throw "Node.js 22 or newer is required."
}
$major = [int](($nodeVersion -replace '^v', '').Split('.')[0])
if ($major -lt 22) {
  throw "Node.js 22 or newer is required; found $nodeVersion."
}

$componentRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $componentRoot
try {
  npm ci --omit=dev --ignore-scripts
  npm run check
} finally {
  Pop-Location
}

Write-Host "Dependencies are installed. Pair explicitly with:"
Write-Host "  node `"$componentRoot\src\main.mjs`" pair"
Write-Host "Then start the user process with:"
Write-Host "  node `"$componentRoot\src\main.mjs`" start"
