$ErrorActionPreference = "Stop"
# Prepare the same real executable before short unit-test deadlines begin.
$releaseRoot = Join-Path $env:RUNNER_TEMP "ripgrep-15.1.0"
New-Item -ItemType Directory -Path $releaseRoot | Out-Null
$archive = Join-Path $releaseRoot "ripgrep.zip"
Invoke-WebRequest -Uri "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-pc-windows-msvc.zip" -OutFile $archive -TimeoutSec 60
$expected = "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a"
if ((Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
  throw "Ripgrep archive digest mismatch"
}
[System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $releaseRoot)
$bin = Join-Path $releaseRoot "ripgrep-15.1.0-x86_64-pc-windows-msvc"
$binary = Join-Path $bin "rg.exe"
$version = & $binary --version
if ($LASTEXITCODE -ne 0 -or -not (($version -join "`n").StartsWith("ripgrep 15.1.0"))) {
  throw "Ripgrep executable version mismatch"
}
$bin | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
Write-Output "Prepared ripgrep 15.1.0 from its verified release archive"
