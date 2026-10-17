#!/usr/bin/env bash
# 结束 --serve 实例：按 instance.json 里的 PID 发 SIGTERM（常驻脚本会按 PID 结束后端进程组并删临时数据目录），
# 然后核对进程、端口、临时目录都没了，证据目录还在。从不按进程名结束。用法：cleanup.sh <输出目录>
set -u
OUT="${1:?用法：cleanup.sh <输出目录>}"
J="$OUT/instance.json"
[ -f "$J" ] || { echo "没有 $J，无事可做"; exit 0; }
get() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];process.stdout.write(v==null?"":String(v))' "$J" "$1"; }
PID="$(get pid)"; SPID="$(get server_pid)"; BASE="$(get base)"; DATA="$(get data_dir)"
if kill -0 "$PID" 2>/dev/null; then kill -TERM "$PID"; fi
for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then echo "常驻脚本 $PID 15 秒未退出，按 PID 强制结束"; kill -KILL "$PID" 2>/dev/null; fi
if kill -0 "-$SPID" 2>/dev/null; then echo "后端进程组 $SPID 仍在，按进程组 PID 强制结束"; kill -KILL "-$SPID" 2>/dev/null; sleep 0.5; fi
fail=0
kill -0 "$PID" 2>/dev/null && { echo "FAIL 常驻脚本 $PID 仍在"; fail=1; } || echo "PASS 常驻脚本 $PID 已退出"
kill -0 "-$SPID" 2>/dev/null && { echo "FAIL 后端进程组 $SPID 仍在"; fail=1; } || echo "PASS 后端进程组 $SPID 已退出"
PORT="${BASE##*:}"
ss -ltnH "sport = :$PORT" | grep -q . && { echo "FAIL 端口 $PORT 仍被监听"; fail=1; } || echo "PASS 端口 $PORT 已释放"
[ -e "$DATA" ] && { echo "WARN 临时数据目录 $DATA 还在（用了 --keep-data？需要时手动删）"; } || echo "PASS 临时数据目录已删"
echo "证据目录保留：$OUT"; ls -1 "$OUT"
exit "$fail"
