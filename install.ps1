#requires -version 5.1
# cast installer (Windows).
#
#   irm https://aa-blinov.github.io/cast/install.ps1 | iex
#
# (published from this file — see .github/workflows/pages.yml)
#
# Downloads the latest (or $env:CAST_VERSION-pinned) release zip and
# unpacks it to $HOME\.cast\install. The release is a pure JS bundle
# (see scripts/build.mjs) — architecture-independent, only Node.js itself
# is required on the machine already.

$ErrorActionPreference = "Stop"

$Repo = if ($env:CAST_REPO) { $env:CAST_REPO } else { "aa-blinov/cast" }
$ApiBase = if ($env:CAST_API_BASE) { $env:CAST_API_BASE } else { "https://api.github.com" }
$DownloadBaseOverride = $env:CAST_DOWNLOAD_BASE
$InstallDir = if ($env:CAST_INSTALL_DIR) { $env:CAST_INSTALL_DIR } else { Join-Path $HOME ".cast\install" }
$MinNodeMajor = 18

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
	Write-Error "Node.js not found. cast's release bundle still needs Node.js $MinNodeMajor+ installed — get it from https://nodejs.org, then re-run this installer."
	exit 1
}

$nodeMajor = [int]((node -e "console.log(process.versions.node.split('.')[0])").Trim())
if ($nodeMajor -lt $MinNodeMajor) {
	Write-Error "Node.js $MinNodeMajor+ required, found $(node -v). Upgrade Node.js and re-run this installer."
	exit 1
}

if ($env:CAST_VERSION) {
	$tag = "v$($env:CAST_VERSION.TrimStart('v'))"
	Write-Host "Installing cast $tag (pinned via CAST_VERSION)..." -ForegroundColor Cyan
	if ($DownloadBaseOverride) {
		$assetUrl = "$($DownloadBaseOverride.TrimEnd('/'))/cast-$($tag.TrimStart('v')).zip"
	} else {
		$assetUrl = "https://github.com/$Repo/releases/download/$tag/cast-$($tag.TrimStart('v')).zip"
	}
} else {
	Write-Host "Looking up the latest cast release..." -ForegroundColor Cyan
	$release = Invoke-RestMethod -Uri "$ApiBase/repos/$Repo/releases/latest"
	$tag = $release.tag_name
	if ($DownloadBaseOverride) {
		$assetUrl = "$($DownloadBaseOverride.TrimEnd('/'))/cast-$($tag.TrimStart('v')).zip"
	} else {
		$asset = $release.assets | Where-Object { $_.name -like "*.zip" } | Select-Object -First 1
		if (-not $asset) {
			Write-Error "Couldn't find a .zip release asset. Is https://github.com/$Repo/releases populated yet?"
			exit 1
		}
		$assetUrl = $asset.browser_download_url
	}
	Write-Host "Latest release: $tag" -ForegroundColor Cyan
}

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $workDir | Out-Null
try {
	$zipPath = Join-Path $workDir "cast.zip"
	Write-Host "Downloading $assetUrl..." -ForegroundColor Cyan
	Invoke-WebRequest -Uri $assetUrl -OutFile $zipPath

	Write-Host "Installing to $InstallDir..." -ForegroundColor Cyan
	if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
	New-Item -ItemType Directory -Path (Split-Path $InstallDir -Parent) -Force | Out-Null
	Expand-Archive -Path $zipPath -DestinationPath $workDir -Force
	Move-Item (Join-Path $workDir "cast") $InstallDir
} finally {
	Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
}

$binDir = Join-Path $InstallDir "bin"
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notlike "*$binDir*") {
	[Environment]::SetEnvironmentVariable("PATH", "$binDir;$userPath", "User")
	Write-Host "Added $binDir to your PATH (restart your terminal to pick it up)." -ForegroundColor Yellow
}

$installedVersion = (Get-Content (Join-Path $InstallDir "package.json") -Raw | ConvertFrom-Json).version
Write-Host "cast $installedVersion installed. Restart your terminal, then run 'cast' to get started." -ForegroundColor Cyan
