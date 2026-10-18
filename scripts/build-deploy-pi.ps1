[CmdletBinding()]
param(
    [switch]$Deploy,
    [switch]$InstallService,
    [string]$Target = 'pi@PiHeizung'
)

$ErrorActionPreference = 'Stop'

if ($InstallService -and -not $Deploy) {
    throw '-InstallService kann nur zusammen mit -Deploy verwendet werden.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$distDirectory = Join-Path $projectRoot 'dist'
$binaryPath = Join-Path $distDirectory 'vieventlog-linux-armv6'

$goCommand = Get-Command go.exe -ErrorAction SilentlyContinue
$goExecutable = if ($goCommand) { $goCommand.Source }

if (-not $goExecutable) {
    $programsDirectory = Join-Path $env:LOCALAPPDATA 'Programs'
    $goExecutable = Get-ChildItem -Path $programsDirectory -Directory -Filter 'Go*' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object { Join-Path $_.FullName 'bin\go.exe' } |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1
}

if (-not $goExecutable -or -not (Test-Path $goExecutable)) {
    throw 'Go wurde nicht gefunden. Installiere Go oder fuege go.exe zum PATH hinzu.'
}

New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null

$environmentNames = @('GOOS', 'GOARCH', 'GOARM', 'CGO_ENABLED')
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    $env:GOOS = 'linux'
    $env:GOARCH = 'arm'
    $env:GOARM = '6'
    $env:CGO_ENABLED = '0'

    Push-Location $projectRoot
    try {
        & $goExecutable build -trimpath -tags nokeyring -ldflags '-s -w' -o $binaryPath .
        if ($LASTEXITCODE -ne 0) {
            throw "Go-Build fehlgeschlagen (Exitcode $LASTEXITCODE)."
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
    }
}

Write-Host "ARMv6-Binary erstellt: $binaryPath"

if (-not $Deploy) {
    return
}

$sshCommand = Get-Command ssh.exe -ErrorAction SilentlyContinue
$scpCommand = Get-Command scp.exe -ErrorAction SilentlyContinue
if (-not $sshCommand -or -not $scpCommand) {
    throw 'Windows OpenSSH (ssh.exe und scp.exe) wird fuer das Deployment benoetigt.'
}

if ([string]::IsNullOrWhiteSpace($Target)) {
    throw 'Das SSH-Ziel darf nicht leer sein.'
}

$sshExecutable = $sshCommand.Source
$scpExecutable = $scpCommand.Source
$deploymentId = [guid]::NewGuid().ToString('N')
$remoteBinaryPath = "/tmp/vieventlog-armv6-$deploymentId"
$remoteBackupPath = "/usr/bin/vieventlog.backup-$deploymentId"
$installServiceValue = if ($InstallService) { '1' } else { '0' }
$serviceUnitBase64 = ''
$environmentTemplateBase64 = ''

if ($InstallService) {
    $serviceUnitPath = Join-Path $projectRoot 'packaging\systemd\vieventlog.service'
    $environmentTemplatePath = Join-Path $projectRoot 'packaging\default\vieventlog.env'
    if (-not (Test-Path $serviceUnitPath) -or -not (Test-Path $environmentTemplatePath)) {
        throw 'Die systemd-Unit oder das Default-Konfigurationstemplate fehlt im Repository.'
    }

    $serviceUnitBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($serviceUnitPath))
    $environmentTemplateBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($environmentTemplatePath))
}

Write-Host "Kopiere Binary nach $Target. OpenSSH fragt das Passwort interaktiv im Terminal ab."
& $scpExecutable -o BatchMode=no -o ConnectTimeout=10 $binaryPath "${Target}:$remoteBinaryPath"
if ($LASTEXITCODE -ne 0) {
    throw "Upload zum Pi fehlgeschlagen (Exitcode $LASTEXITCODE)."
}

$remoteScript = @'
set -eu

binary=/usr/bin/vieventlog
staged='__REMOTE_BINARY_PATH__'
backup='__REMOTE_BACKUP_PATH__'
install_service='__INSTALL_SERVICE__'
service_unit_base64='__SERVICE_UNIT_BASE64__'
environment_template_base64='__ENVIRONMENT_TEMPLATE_BASE64__'
new_binary="${binary}.new.$$"
service_was_installed=0
had_previous_binary=0

cleanup() {
    rm -f "$staged" "$new_binary"
}
trap cleanup EXIT

if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl wurde auf dem Pi nicht gefunden." >&2
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 wird fuer die Health-Pruefung benoetigt." >&2
    exit 1
fi
if systemctl cat vieventlog.service >/dev/null 2>&1; then
    service_was_installed=1
fi

if [ "$install_service" -ne 1 ] && [ "$service_was_installed" -ne 1 ]; then
    echo "Der Dienst fehlt. Fuer die Erstinstallation erneut mit -InstallService starten." >&2
    exit 1
fi
if [ "$install_service" -ne 1 ] && [ ! -x "$binary" ]; then
    echo "Das Binary fehlt. Fuer die Erstinstallation erneut mit -InstallService starten." >&2
    exit 1
fi

if [ "$install_service" -eq 1 ]; then
    if ! getent group vieventlog >/dev/null 2>&1; then
        groupadd --system vieventlog
    fi
    if ! getent passwd vieventlog >/dev/null 2>&1; then
        useradd --system --home-dir /var/lib/vieventlog --no-create-home \
            --shell /usr/sbin/nologin --comment "Viessmann Event Viewer" \
            --gid vieventlog vieventlog
    fi

    install -d -o vieventlog -g vieventlog -m 0750 /var/lib/vieventlog
    if [ ! -e /etc/default/vieventlog ]; then
        printf '%s' "$environment_template_base64" | base64 -d > /etc/default/vieventlog
        chown root:root /etc/default/vieventlog
        chmod 0640 /etc/default/vieventlog
    fi
    if [ "$service_was_installed" -ne 1 ]; then
        printf '%s' "$service_unit_base64" | base64 -d > /etc/systemd/system/vieventlog.service
        chown root:root /etc/systemd/system/vieventlog.service
        chmod 0644 /etc/systemd/system/vieventlog.service
    fi
fi

if [ -e "$binary" ]; then
    if [ ! -f "$binary" ]; then
        echo "$binary ist keine regulaere Datei; breche ab." >&2
        exit 1
    fi
    cp -p "$binary" "$backup"
    had_previous_binary=1
fi

install -o root -g root -m 0755 "$staged" "$new_binary"
mv -f "$new_binary" "$binary"

rollback() {
    if [ "$had_previous_binary" -eq 1 ]; then
        echo "Deployment fehlgeschlagen; stelle das vorherige Binary wieder her." >&2
        mv -f "$backup" "$binary"
        systemctl restart vieventlog.service || true
    else
        echo "Erstinstallation fehlgeschlagen; stoppe den Dienst zurueck." >&2
        systemctl stop vieventlog.service || true
        if [ "$service_was_installed" -ne 1 ]; then
            systemctl disable vieventlog.service || true
        fi
    fi
}

if [ "$install_service" -eq 1 ]; then
    if ! systemctl daemon-reload || ! systemctl enable vieventlog.service; then
        rollback
        exit 1
    fi
fi

if ! systemctl restart vieventlog.service; then
    rollback
    exit 1
fi

healthy=0
for attempt in $(seq 1 20); do
    if systemctl is-active --quiet vieventlog.service && \
        python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/health', timeout=2)"; then
        healthy=1
        break
    fi
    sleep 1
done

if [ "$healthy" -ne 1 ]; then
    rollback
    exit 1
fi

rm -f "$backup"
echo "ViEventLog wurde aktualisiert; Dienst und /health sind erreichbar."
'@

$remoteScript = $remoteScript.Replace('__REMOTE_BINARY_PATH__', $remoteBinaryPath)
$remoteScript = $remoteScript.Replace('__REMOTE_BACKUP_PATH__', $remoteBackupPath)
$remoteScript = $remoteScript.Replace('__INSTALL_SERVICE__', $installServiceValue)
$remoteScript = $remoteScript.Replace('__SERVICE_UNIT_BASE64__', $serviceUnitBase64)
$remoteScript = $remoteScript.Replace('__ENVIRONMENT_TEMPLATE_BASE64__', $environmentTemplateBase64)
$remoteScript = $remoteScript.Replace("`r`n", "`n").Replace("`r", "`n")
$encodedScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
$remoteCommand = "printf '%s' '$encodedScript' | base64 -d | sudo bash"

Write-Host 'Fuehre Installation und Dienstpruefung aus. SSH- und sudo-Passwoerter werden interaktiv abgefragt und nicht gespeichert.'
& $sshExecutable -tt -o BatchMode=no -o ConnectTimeout=10 $Target $remoteCommand
if ($LASTEXITCODE -ne 0) {
    throw "Deployment oder Health-Pruefung fehlgeschlagen (Exitcode $LASTEXITCODE)."
}
