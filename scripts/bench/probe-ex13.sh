#!/usr/bin/env bash
# EX-13 取证脚本（仅在 macOS runner 上跑；不改动仓库内容）
#
# 目标：定位「macOS 上 SEA 内核一执行即被 SIGKILL」的根因，并找出**能执行通过**的签名形态。
# 输出一律走 GitHub 注解（未登录也能读），因为 job 日志需要登录。
#
# 对照设置：
#   0) 裸 node 副本（未注入未重签）——验证「复制 node 二进制」本身没问题
#   1) A 组：构建期产物（postject + ad-hoc 签名后，未经 electron-builder）
#   2) 四种签名变体（各自副本）：官方口径 ad-hoc / --options runtime / 最小 entitlements / 两者叠加
#   3) 系统杀因（amfid 与内核日志，尽力而为）
set -u

BIN="build/kernel/skill-manager.exe"
PLIST="/tmp/sea-entitlements.plist"

note() { printf '::notice::%s\n' "$1"; }
warn() { printf '::warning::%s\n' "$1"; }

# 执行一个二进制并记录退出码（137/负值多为信号终止）
try_run() {
  local label="$1" path="$2" out code
  out=$("$path" --version 2>&1)
  code=$?
  note "${label} → exit=${code}；输出=$(printf '%s' "$out" | head -2 | tr '\n' ' ')"
}

note "环境 ${RUNNER_ARCH} ${RUNNER_OS} $(sw_vers -productVersion) / node $(node -v)"
note "产物 ${BIN}：$(ls -l "$BIN" | awk '{print $1, $5}') / $(file -b "$BIN")"

note "codesign -dv：$(codesign -dv --verbose=4 "$BIN" 2>&1 | tr '\n' ';' | cut -c1-500)"
codesign --verify --deep --strict --verbose=4 "$BIN" > /tmp/verify.txt 2>&1
note "codesign --verify exit=$?：$(head -3 /tmp/verify.txt | tr '\n' ' ')"
note "xattr：$(xattr -l "$BIN" 2>&1 | tr '\n' ' ')"

# 0) 裸 node 副本对照
cp "$(command -v node)" /tmp/node-copy
chmod +x /tmp/node-copy
try_run "对照-裸 node 副本" /tmp/node-copy

# 1) A 组：当前构建期产物
try_run "A-构建期产物（当前签名）" "$PWD/$BIN"

# 2) 签名变体
cat > "$PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
PLIST

sign_variant() {
  local variant="$1"; shift
  local target="/tmp/sea-${variant}"
  cp "$BIN" "$target"
  chmod +x "$target"
  codesign --remove-signature "$target" > /dev/null 2>&1
  codesign "$@" "$target" > /tmp/sign-"$variant".txt 2>&1
  local sign_code=$?
  note "变体 ${variant} 签名 exit=${sign_code} $(head -2 /tmp/sign-"$variant".txt | tr '\n' ' ')"
  try_run "变体-${variant}" "$target"
}

sign_variant "adhoc" --sign - --force
sign_variant "runtime" --sign - --force --options runtime
sign_variant "entitlements" --sign - --force --entitlements "$PLIST"
sign_variant "runtime-entitlements" --sign - --force --options runtime --entitlements "$PLIST"

# 3) 系统杀因（尽力而为：无权限时忽略）
if log show --last 5m --style compact --predicate 'process == "amfid" OR eventMessage CONTAINS "skill-manager"' > /tmp/syslog.txt 2>/dev/null; then
  tail -n 12 /tmp/syslog.txt | while IFS= read -r line; do note "syslog: ${line}"; done
else
  warn "系统日志不可读（权限限制），跳过杀因取证"
fi
