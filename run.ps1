[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AppArgs
)

$rootDir = $PSScriptRoot
Push-Location $rootDir
try {
    $venvPython = Join-Path $rootDir ".venv\Scripts\python.exe"
    if (Test-Path $venvPython) {
        & $venvPython -m eyetype @AppArgs
    } else {
        py -3.11 -m eyetype @AppArgs
    }
} finally {
    Pop-Location
}

