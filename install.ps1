# qq-remote-bridge skill installer — 直接安装到 DSH 技能目录。
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1          # 安装（已存在则跳过）
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Force   # 强制覆盖重装
#
# 效果：把整个仓库复制到 %USERPROFILE%\.dsh\skills\qq-remote-bridge\，
# 之后任意 DSH 会话都能加载 qq-remote-bridge skill（运行时部署仍见 deploy.ps1）。
param(
  [switch]$Force
)
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillRoot = Join-Path $env:USERPROFILE ".dsh\skills"
$Dest = Join-Path $SkillRoot "qq-remote-bridge"

if (Test-Path $Dest) {
  if (-not $Force) {
    Write-Host "[install] 已存在: $Dest"
    Write-Host "[install] 如需覆盖重装, 加 -Force 参数。"
    exit 0
  }
  Write-Host "[install] 覆盖已存在的安装..."
  Remove-Item $Dest -Recurse -Force
}
New-Item -ItemType Directory -Path $SkillRoot -Force | Out-Null
# 排除 git 元数据与运行时产物
Copy-Item $Repo $Dest -Recurse -Force -Exclude ".git"
Write-Host "[install] ✅ 已安装 skill 到: $Dest"
Write-Host "[install] 现在可在任意 DSH 会话中调用 qq-remote-bridge skill；"
Write-Host "[install] 运行时部署请见技能内 SKILL.md（方式 A：deploy.ps1）。"
