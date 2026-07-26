param(
  [string]$Model = 'qwen3:1.7b',
  [int]$BuildPort = 11439
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WorkRoot = Join-Path $ProjectRoot 'work\offline-runtime'
$FullRuntime = Join-Path $WorkRoot 'ollama-full'
$Runtime = Join-Path $WorkRoot 'ollama'
$Models = Join-Path $WorkRoot 'models'
$Legal = Join-Path $WorkRoot 'legal'
$Archive = Join-Path $WorkRoot 'ollama-windows-amd64-v0.31.2.zip'
$ArchiveUrl = 'https://github.com/ollama/ollama/releases/download/v0.31.2/ollama-windows-amd64.zip'
$ArchiveSha256 = '6988b58d2223ae3f9d5766b46b0be614dec36524b80317159718b5adf3006f3b'
$Server = $null

function Remove-WorkItem([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $Resolved = (Resolve-Path -LiteralPath $Path).Path
  if (-not $Resolved.StartsWith($WorkRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside offline work directory: $Resolved"
  }
  Remove-Item -LiteralPath $Resolved -Recurse -Force
}

New-Item -ItemType Directory -Path $WorkRoot, $Models, $Legal -Force | Out-Null

if (Test-Path -LiteralPath $Archive) {
  $ExistingHash = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
  if ($ExistingHash -ne $ArchiveSha256) { Remove-WorkItem $Archive }
}

if (-not (Test-Path -LiteralPath $Archive)) {
  Write-Host 'Downloading official Ollama 0.31.2 standalone runtime...'
  & curl.exe -L --fail --retry 3 --silent --show-error -o $Archive $ArchiveUrl
  if ($LASTEXITCODE -ne 0) { throw 'Ollama download failed.' }
}

$DownloadedHash = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
if ($DownloadedHash -ne $ArchiveSha256) { throw 'Ollama archive checksum mismatch.' }

Remove-WorkItem $FullRuntime
Remove-WorkItem $Runtime
New-Item -ItemType Directory -Path $FullRuntime | Out-Null
Expand-Archive -LiteralPath $Archive -DestinationPath $FullRuntime -Force

New-Item -ItemType Directory -Path (Join-Path $Runtime 'lib\ollama') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $FullRuntime 'ollama.exe') -Destination $Runtime
Get-ChildItem -File (Join-Path $FullRuntime 'lib\ollama') |
  Copy-Item -Destination (Join-Path $Runtime 'lib\ollama')
Copy-Item -LiteralPath (Join-Path $FullRuntime 'lib\ollama\vulkan') `
  -Destination (Join-Path $Runtime 'lib\ollama') -Recurse

& curl.exe -L --fail --silent --show-error `
  -o (Join-Path $Legal 'Ollama-LICENSE.txt') `
  'https://raw.githubusercontent.com/ollama/ollama/v0.31.2/LICENSE'
& curl.exe -L --fail --silent --show-error `
  -o (Join-Path $Legal 'Apache-2.0-LICENSE.txt') `
  'https://www.apache.org/licenses/LICENSE-2.0.txt'

try {
  $env:OLLAMA_HOST = "127.0.0.1:$BuildPort"
  $env:OLLAMA_MODELS = $Models
  $env:OLLAMA_KEEP_ALIVE = '0'
  $Engine = Join-Path $Runtime 'ollama.exe'
  $Server = Start-Process -FilePath $Engine -ArgumentList 'serve' `
    -WorkingDirectory (Split-Path $Engine) -WindowStyle Hidden -PassThru

  $Online = $false
  for ($Attempt = 0; $Attempt -lt 100; $Attempt++) {
    try {
      $null = Invoke-RestMethod -Uri "http://127.0.0.1:$BuildPort/api/tags" -TimeoutSec 1
      $Online = $true
      break
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $Online) { throw 'Bundled Ollama failed to start.' }

  $PullRequest = Join-Path $WorkRoot 'pull.json'
  [System.IO.File]::WriteAllText($PullRequest, (@{ model = $Model; stream = $true } | ConvertTo-Json -Compress))
  $PullLog = Join-Path $WorkRoot 'pull.log'
  & curl.exe --fail --silent --show-error -H 'Content-Type: application/json' `
    --data-binary ('@' + $PullRequest) -o $PullLog "http://127.0.0.1:$BuildPort/api/pull"
  if ($LASTEXITCODE -ne 0) { throw 'Model download failed.' }

  $Tags = Invoke-RestMethod -Uri "http://127.0.0.1:$BuildPort/api/tags" -TimeoutSec 10
  if (-not ($Tags.models.name -contains $Model)) { throw "Downloaded model $Model was not registered." }
  Write-Host "Offline runtime is ready: $Model"
} finally {
  if ($Server -and -not $Server.HasExited) {
    & taskkill.exe /pid $Server.Id /T /F 2>$null | Out-Null
  }
  Remove-Item Env:OLLAMA_HOST, Env:OLLAMA_MODELS, Env:OLLAMA_KEEP_ALIVE -ErrorAction SilentlyContinue
  Remove-WorkItem $FullRuntime
  Remove-WorkItem $Archive
}

