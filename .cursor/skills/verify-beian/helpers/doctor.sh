#!/usr/bin/env bash
# 只读体检：这个实例值不值得驱动？用法：doctor.sh <--serve 的输出目录>
# 读 <目录>/instance.json，检查：我们起的进程在、端口归我们的后端进程组、/api/health 正常且版本等于仓库 VERSION、
# 数据目录是临时目录且不在 runtime/ 或 apps/web/backend/data、本机显示名登录可用。除在这个临时实例上登录一次外不改任何东西，不结束任何进程。
set -u
OUT="${1:?用法：doctor.sh <输出目录>}"
REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
J="$OUT/instance.json"
fail=0
ok()  { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
[ -f "$J" ] || { echo "FAIL 没有 $J（先用 --serve 启动）"; exit 1; }
get() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];process.stdout.write(v==null?"":String(v))' "$J" "$1"; }
PID="$(get pid)"; SPID="$(get server_pid)"; BASE="$(get base)"; DATA="$(get data_dir)"; STOPPED="$(get stopped_at)"
[ -z "$STOPPED" ] || bad "instance.json 记录已于 $STOPPED 停止"
kill -0 "$PID" 2>/dev/null && ok "常驻脚本进程 $PID 在" || bad "常驻脚本进程 $PID 不在"
kill -0 "$SPID" 2>/dev/null && ok "后端进程组 $SPID 在" || bad "后端进程 $SPID 不在"
PORT="${BASE##*:}"
LPID="$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"
if [ -n "$LPID" ] && [ "$(ps -o pgid= -p "$LPID" | tr -d ' ')" = "$SPID" ]; then ok "端口 $PORT 由我们的后端进程组监听（pid $LPID）"; else bad "端口 $PORT 不是我们的后端在听（监听 pid=${LPID:-无}）"; fi
HEALTH="$(curl -fsS --max-time 5 "$BASE/api/health" 2>/dev/null)" || HEALTH=""
WANT="$(tr -d '[:space:]' < "$REPO/VERSION")"
GOT="$(printf '%s' "$HEALTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.ok===true?String(j.version):"")}catch{}})')"
[ "$GOT" = "$WANT" ] && ok "/api/health ok，版本 $GOT = 仓库 VERSION" || bad "/api/health 版本「${GOT:-无响应}」≠ 仓库 VERSION「$WANT」"
case "$DATA" in
  "$REPO/runtime"*|"$REPO/apps/web/backend/data"*|"") bad "数据目录不安全：${DATA:-空}";;
  *) [ -d "$DATA" ] && ok "临时数据目录 $DATA" || bad "数据目录 $DATA 不存在";;
esac
if [ -n "$LPID" ] && [ -r "/proc/$LPID/environ" ]; then
  ENVDATA="$(tr '\0' '\n' < "/proc/$LPID/environ" | sed -n 's/^WB_DATA_DIR=//p')"
  [ "$ENVDATA" = "$DATA" ] && ok "后端进程的 WB_DATA_DIR 就是该临时目录" || bad "后端 WB_DATA_DIR=「$ENVDATA」与 instance.json 不符"
fi
ME="$(curl -fsS --max-time 5 -c /dev/null -H 'content-type: application/json' -d '{"display_name":"管理员"}' "$BASE/api/auth/login" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).role||"")}catch{}})')"
[ "$ME" = "admin" ] && ok "本机显示名登录「管理员」可用（role=admin）" || bad "显示名登录失败（role=${ME:-无}）"
[ "$fail" = 0 ] && echo "DOCTOR PASS" || echo "DOCTOR FAIL"
exit "$fail"
