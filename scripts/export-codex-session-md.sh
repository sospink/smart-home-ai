#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "用法: $0 <session.jsonl> <session-id> <output.md>" >&2
  exit 2
fi

session_file="$1"
session_id="$2"
output_file="$3"
output_dir="$(dirname "$output_file")"
temp_file="${output_file}.tmp"

if [[ ! -f "$session_file" ]]; then
  echo "会话文件不存在: $session_file" >&2
  exit 1
fi

mkdir -p "$output_dir"
trap 'rm -f "$temp_file"' EXIT

{
  printf '# Codex 会话上下文归档\n\n'
  printf -- '- 会话 ID：`%s`\n' "$session_id"
  printf -- '- 导出范围：用户与助手可见消息（不包含系统提示、隐藏推理和工具原始输出）\n'
  printf -- '- 安全处理：凭证、Token、PIN、密码与内嵌图片已脱敏或替换为占位说明\n'
  printf -- '- 原始会话：`%s`（仅作本机来源说明，不复制进仓库）\n\n' "$session_file"
  printf '> 本文件用于当前智慧家居平台的真实硬件接入评估。时间为原始会话记录中的 UTC 时间。\n\n'

  jq -r '
    select(
      .type == "response_item"
      and .payload.type == "message"
      and (.payload.role == "user" or .payload.role == "assistant")
    )
    | (.payload.content // []) as $content
    | ($content
        | map(
            if .type == "input_text" or .type == "output_text" then (.text // "")
            elif .type == "input_image" then "[会话内嵌图片已省略]"
            else empty
            end
          )
        | join("\n\n")) as $body
    | select(
        ($body | startswith("<environment_context>")) | not
      )
    | select(
        ($body | startswith("<codex_internal_context")) | not
      )
    | "## \(.timestamp // "未知时间") · \(if .payload.role == "user" then "用户" else "助手" end)\n\n\($body)\n\n---\n"
  ' "$session_file"
} |
  perl -pe '
    s/(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/$1[REDACTED]/gi;
    s/((?:HA_)?TOKEN\s*[:=：]\s*)[^\s`"'"'"'<>，。；]+/$1[REDACTED]/gi;
    s/((?:access[_ -]?token|long[- ]lived token|令牌)\s*[:=：]\s*)[^\s`"'"'"'<>，。；]+/$1[REDACTED]/gi;
    s/((?:管理员\s*)?PIN\s*[:=：]\s*)\d{4,12}/$1[REDACTED]/gi;
    s/((?:密码|password|secret)\s*[:=：]\s*)[^\s`"'"'"'<>，。；]+/$1[REDACTED]/gi;
    s/\beyJ[A-Za-z0-9._~-]{40,}\b/[REDACTED_JWT]/g;
  ' > "$temp_file"

mv "$temp_file" "$output_file"
trap - EXIT

echo "已导出: $output_file"
