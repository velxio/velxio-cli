# Installs velxio-cli into $HOME\.velxio\bin from the GitHub release assets.
#
#   irm https://velxio.dev/ci/install.ps1 | iex
#   $env:VELXIO_CLI_VERSION = 'v0.1.0'; irm ... | iex     # pin a version
#
# Downloads velxio-cli_v<ver>_Windows_64bit.zip, checks it against the
# release's SHA256SUMS, unzips it and prints PATH advice.
$ErrorActionPreference = 'Stop'

$Repo = 'velxio/velxio-cli'
$BinDir = if ($env:VELXIO_CLI_BIN_DIR) { $env:VELXIO_CLI_BIN_DIR } else { Join-Path $HOME '.velxio\bin' }
$Version = $env:VELXIO_CLI_VERSION

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') { throw "install.ps1: unsupported CPU $arch (only x64 builds are published)" }

if (-not $Version) {
  $latest = Invoke-WebRequest -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
  $Version = ($latest.Content | ConvertFrom-Json).tag_name
}
if (-not $Version.StartsWith('v')) { $Version = "v$Version" }

$Asset = "velxio-cli_${Version}_Windows_64bit.zip"
$Base = "https://github.com/$Repo/releases/download/$Version"
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("velxio-cli-" + [System.Guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $Tmp | Out-Null

try {
  Write-Host "downloading $Asset"
  Invoke-WebRequest -Uri "$Base/$Asset" -OutFile (Join-Path $Tmp $Asset) -UseBasicParsing
  Invoke-WebRequest -Uri "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp 'SHA256SUMS') -UseBasicParsing

  $line = Get-Content (Join-Path $Tmp 'SHA256SUMS') | Where-Object { $_ -match "\s$([regex]::Escape($Asset))$" }
  if (-not $line) { throw "$Asset is not listed in SHA256SUMS" }
  $expected = ($line -split '\s+')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Tmp $Asset)).Hash.ToLower()
  if ($expected -ne $actual) { throw "SHA256 mismatch for $Asset (expected $expected, got $actual)" }

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  Expand-Archive -Path (Join-Path $Tmp $Asset) -DestinationPath (Join-Path $Tmp 'unpacked') -Force
  Copy-Item (Join-Path $Tmp 'unpacked\velxio-cli.exe') (Join-Path $BinDir 'velxio-cli.exe') -Force

  $installed = & (Join-Path $BinDir 'velxio-cli.exe') version
  Write-Host "installed $installed to $BinDir\velxio-cli.exe"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $BinDir)) {
    Write-Host ''
    Write-Host 'add it to your PATH (user scope):'
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"$BinDir;`" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
  }
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
