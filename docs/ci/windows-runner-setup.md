# Windows CI runner — VM-internal setup

One-time setup **inside** the Windows VM (the `forgejo-runner-windows` /
`dockurr/windows` compose service) that serves the `windows-latest` leg of
[ci.yml](../../.forgejo/workflows/ci.yml). Run it once after Windows finishes
installing; afterwards the runner survives VM reboots as a service.

## Prerequisites
https://nextcloud.informethic.ch/s/i7XjdC6z4KPBwBY
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

# 3) forgejo-runner: register against the instance, install as a service.
#    NOTE: upstream publishes NO Windows binaries (v12 releases are linux-only)
#    — use the locally cross-compiled exe (see "Building the exe" below) and
#    bring it into the VM (e.g. via the Nextcloud share above), saved as
#    C:\runner\forgejo-runner.exe. Version should track the Linux runner's
#    major (compose: data.forgejo.org/forgejo/runner:12).
mkdir C:\runner; cd C:\runner
# <download/copy forgejo-runner-12.9.0-windows-amd64.exe here as forgejo-runner.exe>
.\forgejo-runner.exe register --no-interactive `
  --instance https://forgejo.informethic.ch `
  --token 53ff6f2c9d7f4589c8f95f8e69378306197832a2 `
  --name windows-ci `
  --labels windows-latest:host
nssm install forgejo-runner C:\runner\forgejo-runner.exe daemon
nssm set forgejo-runner AppDirectory C:\runner
nssm start forgejo-runner
```

## Building the exe (on Linux)

The runner is plain Go, so any Linux box cross-compiles it:

```sh
git clone --depth 1 --branch v12.9.0 https://code.forgejo.org/forgejo/runner.git
cd runner
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
  -tags 'netgo osusergo' \
  -ldflags '-s -w -X "code.forgejo.org/forgejo/runner/v12/internal/pkg/ver.version=v12.9.0"' \
  -o forgejo-runner-12.9.0-windows-amd64.exe .
```

Current build (2026-07-12) lives at
`~/Documents/Forgejo/windows-runner/forgejo-runner-12.9.0-windows-amd64.exe`,
sha256 `e599ae2d3ae487ce63ce1d1903156d0b2d783b9c6e0916682c81fcec85c5cf0d`.
Verify in the VM with `Get-FileHash C:\runner\forgejo-runner.exe`.

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
