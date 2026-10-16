#!/usr/bin/env bash
# EX-13 验证脚本之二：B 组（electron-builder 打包后的 .app 内内核）与 C 组（v0.1.0 发布 dmg 内内核）
#
# 用法（macOS runner）：bash scripts/bench/probe-ex13-package.sh <arm64|x64> [发布 tag，默认 v0.1.1]
# 结论同样以注解输出（未登录可读）。
set -u

ARCH="${1:-arm64}"
TAG="${2:-v0.1.1}"
VERSION="${TAG#v}"
DMG_NAME="skill-manager-${VERSION}-${ARCH}.dmg"

note() { printf '::notice::%s\n' "$1"; }
warn() { printf '::warning::%s\n' "$1"; }

try_run() {
  local label="$1" path="$2" out code
  if [ ! -x "$path" ]; then
    warn "${label} → 未找到可执行文件（路径：${path}）"
    return 0
  fi
  out=$("$path" --version 2>&1)
  code=$?
  note "${label} --version → exit=${code}；输出=$(printf '%s' "$out" | head -2 | tr '\n' ' ')"
  # 闭环检查：init → scan（比 --version 强，能证明内核真能干活）
  WORKSPACE=$(mktemp -d)
  "$path" init --workspace "$WORKSPACE" > /dev/null 2>&1
  init_code=$?
  "$path" scan --workspace "$WORKSPACE" > /dev/null 2>&1
  scan_code=$?
  if [ "$init_code" -eq 0 ] && [ "$scan_code" -eq 0 ]; then
    note "${label} 闭环 init/scan → exit=${init_code}/${scan_code}（通过）"
  else
    warn "${label} 闭环 init/scan → exit=${init_code}/${scan_code}"
  fi
  rm -rf "$WORKSPACE"
}

sign_of() {
  local label="$1" path="$2"
  codesign --verify --deep --strict "$path" > /tmp/sig.txt 2>&1
  note "${label} 签名校验 exit=$?；$(head -2 /tmp/sig.txt | tr '\n' ' ')"
}

# ---------- B 组：electron-builder 打包后的 .app ----------
note "B 组开始（electron-builder ${ARCH}）"
# 打包入口在 GUI workspace：`pack:mac` / `pack:mac:x64`（B 组的目的是验证「打包后的 .app 内内核」）
if [ "$ARCH" = "x64" ]; then
  npm run pack:mac:x64 -w @skill-manager/gui > /tmp/pack.log 2>&1
else
  npm run pack:mac -w @skill-manager/gui > /tmp/pack.log 2>&1
fi
note "打包 exit=$?；日志末段=$(tail -3 /tmp/pack.log | tr '\n' ' ' | cut -c1-300)"

APP_DIR=$(ls -d build/desktop/mac*/skill-manager.app 2>/dev/null | head -1)
if [ -n "${APP_DIR:-}" ]; then
  note "B 组产物：${APP_DIR}"
  sign_of "B-整包" "$APP_DIR"
  try_run "B-包内内核" "$APP_DIR/Contents/Resources/kernel/skill-manager.exe"
else
  warn "B 组未找到 .app（打包可能失败，见日志）"
fi

# ---------- C 组：发布 dmg ----------
note "C 组开始（${TAG} ${DMG_NAME}）"
curl -sL --ssl-no-revoke -o /tmp/release.dmg \
  "https://github.com/LuZhong-Li/skill-manager/releases/download/${TAG}/${DMG_NAME}"
note "C 组下载：$(ls -l /tmp/release.dmg | awk '{print $5}') 字节"

MOUNT=$(mktemp -d /tmp/dmg.XXXXXX)
if hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" /tmp/release.dmg > /tmp/attach.log 2>&1; then
  APP=$(ls -d "$MOUNT"/skill-manager.app 2>/dev/null | head -1)
  if [ -n "${APP:-}" ]; then
    sign_of "C-包内内核" "$APP/Contents/Resources/kernel/skill-manager.exe"
    try_run "C-发布包内内核" "$APP/Contents/Resources/kernel/skill-manager.exe"
  else
    warn "C 组未在 dmg 内找到 skill-manager.app"
  fi
  hdiutil detach "$MOUNT" > /dev/null 2>&1
else
  warn "C 组挂载失败：$(tail -2 /tmp/attach.log | tr '\n' ' ')"
fi

note "取证完成（${ARCH}）"
