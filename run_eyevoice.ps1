[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AppArgs
)

$rootDir = $PSScriptRoot
Push-Location $rootDir
try {
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host "  Starting EyeVoice Patient Communication Dashboard" -ForegroundColor Green
    Write-Host "  Web interface: http://localhost:5000" -ForegroundColor Yellow
    Write-Host "  Caregiver view: http://localhost:5000/caregiver" -ForegroundColor Yellow
    Write-Host "========================================================" -ForegroundColor Cyan
    $venvPython = Join-Path $rootDir ".venv\Scripts\python.exe"
    if (Test-Path $venvPython) {
        & $venvPython -m eyevoice.server @AppArgs
    } else {
        py -3.11 -m eyevoice.server @AppArgs
    }
} finally {
    Pop-Location
}

