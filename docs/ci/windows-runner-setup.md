# Windows CI runner — VM-internal setup

One-time setup **inside** the Windows VM (the `forgejo-runner-windows` /
`dockurr/windows` compose service) that serves the `windows-latest` leg of
[ci.yml](../../.forgejo/workflows/ci.yml). Run it once after Windows finishes
installing; afterwards the runner survives VM reboots as a service.

## Prerequisites

- The VM is booted and reachable via the web viewer (`http://127.0.0.1:8006`).
- A runner **registration token**: Site administration → Actions → Runners →
  Create registration token.

## Setup (paste into an *administrator* PowerShell)

Replace `<REG_TOKEN>` with the registration token before pasting.

```powershell
# 1) Chocolatey (package manager — everything below installs through it)
Set-ExecutionPolicy Bypass -Scope Process -Force
iex ((New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# 2) Toolchain: git, PowerShell 7, service wrapper, Rust (MSVC host triple),
#    and the C++ build tools (the MSVC linker ci.yml's cargo check needs)
choco install -y git pwsh nssm rustup.install
choco install -y visualstudio2022buildtools --package-parameters "--add Microsoft.VisualStudio.Workload.VCTools --quiet --norestart"
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + "$env:USERPROFILE\.cargo\bin"
rustup default stable-msvc

# 3) forgejo-runner: download, register against the instance, install as a service.
#    Version should track the Linux runner's major (compose: data.forgejo.org/forgejo/runner:12).
mkdir C:\runner; cd C:\runner
Invoke-WebRequest https://code.forgejo.org/forgejo/runner/releases/download/v12.9.0/forgejo-runner-12.9.0-windows-amd64.exe -OutFile forgejo-runner.exe
.\forgejo-runner.exe register --no-interactive `
  --instance https://forgejo.informethic.ch `
  --token <REG_TOKEN> `
  --name windows-ci `
  --labels windows-latest:host
nssm install forgejo-runner C:\runner\forgejo-runner.exe daemon
nssm set forgejo-runner AppDirectory C:\runner
nssm start forgejo-runner
```

If the runner download 404s, the asset name changed — pick the
`windows-amd64.exe` asset from
<https://code.forgejo.org/forgejo/runner/releases> and adjust the URL.

## Verify

1. Site administration → Actions → Runners: `windows-ci` shows **online** with
   the `windows-latest` label.
2. Re-run CI on any commit — the `windows-latest` matrix leg should leave
   *queued* and go green (it compile-checks `src-tauri` with MSVC; tests run on
   the Linux leg only).

## Maintenance

- **Update the runner**: `nssm stop forgejo-runner`, replace
  `C:\runner\forgejo-runner.exe` with the new `windows-amd64.exe`,
  `nssm start forgejo-runner`. Registration (`C:\runner\.runner`) is kept.
- **Update the toolchain**: `choco upgrade all -y` and `rustup update`.
- **Logs / service control**: `nssm status forgejo-runner`; stdout/err can be
  captured via `nssm set forgejo-runner AppStdout C:\runner\runner.log` (and
  `AppStderr`) if debugging is needed.
- Node and pnpm are **not** preinstalled on purpose — `actions/setup-node` and
  `pnpm/action-setup` provision them per-job from the instance-local mirrors.
