# Wayfarer Smart Home aktualisieren.
# Lädt die neueste Version von GitHub und ersetzt die Programmdateien.
# Deine config.json und der Ordner "data" werden NICHT verändert.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # sonst ist der Download in Windows PowerShell sehr langsam
$repo = 'Marcbambam/Wayfarer'
$ziel = $PSScriptRoot
$tmp = Join-Path $env:TEMP ("wayfarer-update-" + [guid]::NewGuid().ToString('N'))

function Info($text) { Write-Host "  $text" }

try {
    Write-Host ''
    Info 'Wayfarer Smart Home wird aktualisiert ...'
    Write-Host ''

    # 1. Laufende Zentrale aus diesem Ordner beenden (start.cmd startet sie mit vollem Pfad)
    $server = Join-Path $ziel 'server.js'
    $laufend = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($server) }
    if ($laufend) {
        Info 'Laufende Zentrale wird beendet ...'
        $laufend | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 1
    }
    else {
        Info 'Falls die Zentrale noch in einem anderen Fenster läuft: dieses Fenster bitte schließen.'
    }

    # 2. Neueste Version herunterladen
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp 'wayfarer.zip'
    Info 'Lade neueste Version von GitHub ...'
    Invoke-WebRequest -Uri "https://github.com/$repo/archive/HEAD.zip" -OutFile $zip -UseBasicParsing

    # 3. Entpacken
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $quelle = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
    if (-not $quelle -or -not (Test-Path (Join-Path $quelle.FullName 'server.js'))) {
        throw 'Der Download sieht nicht nach Wayfarer aus.'
    }

    # 4. Sicherung von config.json und data (nur zur Sicherheit, sie werden nicht überschrieben)
    $sicherung = Join-Path $ziel 'sicherung'
    if (Test-Path (Join-Path $ziel 'config.json')) {
        New-Item -ItemType Directory -Path $sicherung -Force | Out-Null
        Copy-Item (Join-Path $ziel 'config.json') (Join-Path $sicherung 'config.json') -Force
    }
    if (Test-Path (Join-Path $ziel 'data')) {
        New-Item -ItemType Directory -Path $sicherung -Force | Out-Null
        # Ziel ist der übergeordnete Ordner, sonst entsteht beim zweiten Mal sicherung\data\data
        Copy-Item (Join-Path $ziel 'data') $sicherung -Recurse -Force
    }

    # 5. Programmdateien ersetzen (config.json und data sind im Download nicht enthalten)
    Get-ChildItem -Path $quelle.FullName -Force | Where-Object { $_.Name -notin @('config.json', 'data', 'sicherung') } | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $ziel -Recurse -Force
    }

    Write-Host ''
    Info 'Fertig! Deine Einstellungen (config.json, data) sind erhalten.'
    Write-Host ''
    Info 'Zentrale wird neu gestartet ...'
    Start-Process -FilePath (Join-Path $ziel 'start.cmd') -WorkingDirectory $ziel
}
catch {
    Write-Host ''
    Write-Host "  FEHLER: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  Es wurde nichts an deinen Einstellungen verändert.'
    Write-Host '  Alternativ: Neue Version als ZIP von GitHub laden und config.json + data mitkopieren.'
}
finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
