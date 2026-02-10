param(
  [Parameter(Mandatory = $true)]
  [string]$ApiUrl,

  [string]$Token = "",

  [string]$HapiHome = $(if ($env:HAPI_HOME) { $env:HAPI_HOME } else { Join-Path $HOME ".hapi" })
)

$settingsPath = Join-Path $HapiHome "settings.json"
New-Item -ItemType Directory -Force -Path $HapiHome | Out-Null

$data = @{}
if (Test-Path $settingsPath) {
  try {
    $raw = Get-Content -Raw -Path $settingsPath -ErrorAction Stop
    if ($raw.Trim().Length -gt 0) {
      $obj = $raw | ConvertFrom-Json -ErrorAction Stop
      $obj.PSObject.Properties | ForEach-Object { $data[$_.Name] = $_.Value }
    }
    $ts = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item -Force $settingsPath "$settingsPath.bak.$ts" -ErrorAction SilentlyContinue | Out-Null
  } catch {
    $data = @{}
  }
}

$data["apiUrl"] = $ApiUrl
if ($Token.Trim().Length -gt 0) { $data["cliApiToken"] = $Token.Trim() }

$json = ($data | ConvertTo-Json -Depth 20)
Set-Content -Path $settingsPath -Value $json -Encoding UTF8

Write-Host "Wrote: $settingsPath"

