# Scout: build the data once, then start the app at http://localhost:8000
# Usage (PowerShell, from this folder):
#   .\run.ps1              start Scout (homes + commercial, DeepAgents)
#   .\run.ps1 -Rebuild     re-run the CoStar data pipeline first
#   .\run.ps1 -Floorproof  start the earlier Floorproof app instead
param([switch]$Rebuild, [switch]$Floorproof)
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path ".env")) {
    if (Test-Path "env") { Rename-Item "env" ".env" }
    else { Write-Host "Copy env.example to .env and fill in the keys first." -ForegroundColor Yellow; exit 1 }
}
if ($Rebuild -or -not (Test-Path "data\built\graph.pkl")) {
    python pipeline/build_all.py
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not $Floorproof) {
    if (-not (Test-Path "data\homes\catalog.json")) {
        # HomeFit's catalog: the team repo's own data/catalog.json when this folder sits inside it, else a sibling checkout
        $parent = Split-Path $PSScriptRoot -Parent
        $catalog = @((Join-Path $parent "data\catalog.json"), (Join-Path $parent "HackPrinceton2026\data\catalog.json")) | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($catalog) { New-Item -ItemType Directory -Force "data\homes" | Out-Null; Copy-Item $catalog "data\homes\catalog.json" }
        else { Write-Host "Missing data\homes\catalog.json (HomeFit apartment catalog)." -ForegroundColor Yellow; exit 1 }
    }
    if (-not ((Test-Path "data\places\houston.json") -and (Test-Path "data\places\los_angeles.json"))) {
        Write-Host "Downloading the OpenStreetMap places snapshot (one time, a few minutes)..." -ForegroundColor Cyan
        python pipeline/fetch_places.py
    }
}
$module = if ($Floorproof) { "api.main:app" } else { "scout.main:app" }
Write-Host "`nStarting - open http://localhost:8000 (Ctrl+C to stop)`n" -ForegroundColor Green
Start-Process "http://localhost:8000"
python -m uvicorn $module --port 8000
