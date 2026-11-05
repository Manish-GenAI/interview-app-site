<#
  Interview App - one-command installer for Windows.

    powershell -ExecutionPolicy Bypass -c "irm https://manish-genai.github.io/interview-app-site/install.ps1 | iex"

  What it does:
    1. Makes sure Git and Python are installed (offers to install them with winget).
    2. Clones (or updates) the app into D:\Interview APP, or %USERPROFILE%\Interview APP if there's no D: drive.
       The repository is private, so Git asks you to sign in to GitHub once (a browser window opens).
    3. Runs scripts\setup.ps1: Python packages, local Whisper speech-to-text, Ollama models.
    4. Adds an "Interview App" shortcut to your desktop and starts the app (http://127.0.0.1:8765).

  When run as a file you can pass: -Path, -Branch, -Repo, -NoGpu, -NoModels, -NoShortcut, -NoStart
#>
param(
    [string]$Path = "",
    [string]$Branch = "claude/sweet-pascal-pnr2pl",
    [string]$Repo = "https://github.com/Manish-GenAI/Interview-App.git",
    [switch]$NoGpu,
    [switch]$NoModels,
    [switch]$NoShortcut,
    [switch]$NoStart
)
$ErrorActionPreference = "Stop"

function Invoke-Native([scriptblock]$Command) {
    # Windows PowerShell 5.1 can turn a tool's normal stderr output (git/pip progress) into a fatal error when
    # $ErrorActionPreference is Stop. Run native tools with Continue and check $LASTEXITCODE instead.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Command } finally { $ErrorActionPreference = $previous }
}
function Write-Step([string]$Message) { Write-Host "`n== $Message" -ForegroundColor Cyan }
function Test-Command([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
}
function Test-Python {
    foreach ($v in @("3.12", "3.11", "3.13", "3.10")) {
        try { $null = & py "-$v" -c "import sys" 2>$null; if ($LASTEXITCODE -eq 0) { return $true } } catch {}
    }
    try { return ((& python -c "import sys; print(sys.version_info >= (3, 10))" 2>$null) -eq "True") } catch { return $false }
}
function Install-WithWinget([string]$Id, [string]$What) {
    if (-not (Test-Command winget)) { return }
    Write-Host "Installing $What with winget..."
    Invoke-Native { winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements }
    Update-SessionPath
}

Write-Host "`nInterview App installer" -ForegroundColor Green
if (-not $Path) {
    $Path = if (Test-Path "D:\") { "D:\Interview APP" } else { Join-Path $HOME "Interview APP" }
}
Write-Host "Install folder: $Path"

Write-Step "1/5 Checking Git"
if (-not (Test-Command git)) { Install-WithWinget "Git.Git" "Git" }
if (-not (Test-Command git)) {
    throw "Git is required. Install it from https://git-scm.com/download/win, then run this installer again."
}

Write-Step "2/5 Checking Python"
if (-not (Test-Python)) { Install-WithWinget "Python.Python.3.12" "Python 3.12" }
if (-not (Test-Python)) {
    throw "Python 3.10+ is required. Install Python 3.12 from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then run this installer again."
}

Write-Step "3/5 Getting the app"
if (Test-Path (Join-Path $Path ".git")) {
    Write-Host "Updating the existing copy in $Path"
    Invoke-Native { git -C "$Path" fetch origin $Branch }
    if ($LASTEXITCODE -eq 0) { Invoke-Native { git -C "$Path" checkout $Branch } }
    if ($LASTEXITCODE -eq 0) { Invoke-Native { git -C "$Path" pull --ff-only origin $Branch } }
} else {
    if ((Test-Path $Path) -and (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1)) {
        throw "$Path already exists and isn't empty. Pick another folder: download install.ps1 and run it with -Path 'E:\Interview APP'."
    }
    Write-Host "Cloning into $Path (sign in to GitHub if asked)"
    Invoke-Native { git clone -b $Branch $Repo "$Path" }
}
if ($LASTEXITCODE -ne 0) {
    throw "Git failed (exit code $LASTEXITCODE). If you were asked to sign in, use the GitHub account that can see the repository, then try again."
}

if (-not $NoModels -and -not (Test-Command ollama) -and (Test-Command winget)) {
    $answer = Read-Host "Ollama runs the AI models on your GPU. Install it now with winget? (Y/n)"
    if ($answer -eq "" -or $answer -match "^[Yy]") { Install-WithWinget "Ollama.Ollama" "Ollama" }
}

Write-Step "4/5 Setting up (Python packages, speech-to-text, models)"
$setupArgs = @{}
if ($NoGpu) { $setupArgs["NoGpu"] = $true }
if ($NoModels) { $setupArgs["NoModels"] = $true }
& (Join-Path $Path "scripts\setup.ps1") @setupArgs
if ($LASTEXITCODE -ne 0) { throw "Setup failed (see the messages above)." }

Write-Step "5/5 Finishing"
$start = Join-Path $Path "scripts\start.bat"
if (-not $NoShortcut) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path $desktop "Interview App.lnk"))
    $link.TargetPath = $start
    $link.WorkingDirectory = Join-Path $Path "scripts"
    $link.Description = "Start Interview App (opens http://127.0.0.1:8765)"
    $link.Save()
    Write-Host "Added an 'Interview App' shortcut to your desktop."
}
Write-Host "`nInstalled in $Path. Your data is stored in $(Join-Path $Path 'data')." -ForegroundColor Green
if (-not $NoStart) {
    Write-Host "Starting the app - keep its window open; the browser opens http://127.0.0.1:8765 when it's ready."
    Start-Process -FilePath $start -WorkingDirectory (Join-Path $Path "scripts")
} else {
    Write-Host "Start it any time with the desktop shortcut or $start"
}
