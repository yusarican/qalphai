#!/usr/bin/env bash
#
# qalphai — brings up the engine and the operator console together.
#
#   ./start.sh            engine :3001 (tsx) + console :3000 (next dev)
#   ./start.sh --build    console in production mode (next build && next start)
#   ./start.sh --engine   engine only
#   ./start.sh --panel    console only, against an engine already running
#
# Ctrl+C stops BOTH. A backend left behind is worse than a crash: the next run finds
# the port taken, the console silently attaches to the OLD engine, and numbers that
# came from a dead process keep rendering as if they were fresh. So every exit path
# cleans up (trap EXIT).
#
# Written for bash 3.2 — the system bash on macOS. No `wait -n`, no associative arrays.

set -euo pipefail

cd "$(dirname "$0")"

BACKEND_PORT="${PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

MODE=all      # all | engine | panel
PROD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)  PROD=true ;;
    --engine|--engine-only) MODE=engine ;;
    --panel|--panel-only)   MODE=panel ;;
    -h|--help)
      cat <<'USAGE'
qalphai — brings up the engine and the operator console together.

  ./start.sh            engine :3001 (tsx) + console :3000 (next dev)
  ./start.sh --build    console in production mode (next build && next start)
  ./start.sh --engine   engine only
  ./start.sh --panel    console only, against an engine already running

Ports come from PORT (engine) and FRONTEND_PORT (console).
Ctrl+C stops everything this script started.
USAGE
      exit 0
      ;;
    *)
      echo "unknown option: $1  (try --help)" >&2
      exit 2
      ;;
  esac
  shift
done

run_engine=true; run_panel=true
[[ "$MODE" == "panel"  ]] && run_engine=false
[[ "$MODE" == "engine" ]] && run_panel=false

backend_pid=""
frontend_pid=""

cleaned=false
cleanup() {
  # A signal runs this, then the script unwinds and EXIT runs it again. Without the
  # guard the operator sees the shutdown reported twice and wonders what restarted.
  $cleaned && return 0
  cleaned=true
  echo ""
  echo "shutting down..."
  # Both sides fork children (tsx, next workers). Killing the process group instead of
  # the pid is what stops the console from dying while the engine keeps trading.
  [[ -n "$frontend_pid" ]] && kill -- "-$frontend_pid" 2>/dev/null || true
  [[ -n "$backend_pid"  ]] && kill -- "-$backend_pid"  2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

port_busy() { lsof -ti :"$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ preflight ---

node -e 'const [a,b]=process.versions.node.split(".").map(Number);
         if (a<20 || (a===20 && b<11)) { console.error("node >= 20.11 required, found "+process.versions.node); process.exit(1); }'

if $run_engine; then
  if [[ ! -f .env ]]; then
    echo "[setup] no .env — copying .env.example (Binance keys are left blank)"
    cp .env.example .env
  fi
  # Firestore backs the candle cache and the nightly loop only; the console reads
  # local files. Missing credentials are worth saying out loud, not worth blocking on.
  sa_path="$(grep -E '^FIREBASE_SERVICE_ACCOUNT_PATH=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  [[ -z "$sa_path" ]] && sa_path=serviceaccount.json
  [[ -f "$sa_path" ]] || echo "[warn] $sa_path missing — the nightly loop and the candle cache will fail. The console still runs."
fi

if $run_engine && [[ ! -d node_modules ]]; then
  echo "[setup] engine dependencies..."
  npm install
fi
if $run_panel && [[ ! -d frontend/node_modules ]]; then
  echo "[setup] console dependencies..."
  (cd frontend && npm install)
fi

if $run_engine && port_busy "$BACKEND_PORT"; then
  echo "ERROR: port :$BACKEND_PORT is taken. In use by:"
  lsof -i :"$BACKEND_PORT" | tail -n +2
  echo ""
  echo "  free it with:  kill \$(lsof -ti :$BACKEND_PORT)"
  exit 1
fi

# next dev quietly picks the next free port when 3000 is taken, and the engine's CORS
# origin is pinned to FRONTEND_URL — so a shifted port shows up as blocked requests
# rather than as a message. Better to stop here.
if $run_panel && port_busy "$FRONTEND_PORT"; then
  echo "ERROR: port :$FRONTEND_PORT is taken. In use by:"
  lsof -i :"$FRONTEND_PORT" | tail -n +2
  echo ""
  echo "  free it with:  kill \$(lsof -ti :$FRONTEND_PORT)"
  exit 1
fi

# --------------------------------------------------------------------- engine ---

if $run_engine; then
  echo "[engine] starting  :$BACKEND_PORT"
  set -m  # give each side its own process group, so cleanup can kill the group
  npx tsx src/index.ts &
  backend_pid=$!
  set +m

  # The console's pages render against the engine on first paint; if it answers late,
  # the operator's first screen reads "engine unreachable" and stays there. Wait for
  # the health gate before handing over.
  printf '[engine] waiting for health'
  for i in $(seq 1 40); do
    if curl -fs "http://localhost:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
      echo " — up"
      break
    fi
    if ! kill -0 "$backend_pid" 2>/dev/null; then
      echo ""
      echo "ERROR: the engine died before it came up. See the log above."
      exit 1
    fi
    printf '.'
    sleep 0.5
    if [[ $i -eq 40 ]]; then
      echo ""
      echo "ERROR: no answer from /api/health within 20s."
      exit 1
    fi
  done

  # Whether real orders go out is the one fact worth reading before anything else.
  curl -fs "http://localhost:$BACKEND_PORT/api/health" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const h=JSON.parse(s);
      const mode = h.liveTrading ? "LIVE ORDERS" : "dry run (logs only)";
      const net  = h.testnet ? "testnet" : "MAINNET";
      console.log(`[engine] ${mode} · ${net} · keys ${h.hasKeys ? "loaded" : "MISSING"} · ${h.interval} · nightly "${h.nightlyCron}"`);
    });'
else
  curl -fs "http://localhost:$BACKEND_PORT/api/health" >/dev/null 2>&1 \
    || echo "[warn] nothing answering on :$BACKEND_PORT — the console will render \"engine unreachable\"."
fi

# -------------------------------------------------------------------- console ---

if $run_panel; then
  if $PROD; then
    # Foreground, so a type error fails here with the compiler's output in view
    # instead of scrolling past under the engine's log.
    echo "[console] production build..."
    (cd frontend && npm run build)
    echo "[console] serving build  :$FRONTEND_PORT"
    set -m
    (cd frontend && npm run start -- --port "$FRONTEND_PORT") &
  else
    echo "[console] dev  :$FRONTEND_PORT"
    set -m
    (cd frontend && npm run dev -- --port "$FRONTEND_PORT") &
  fi
  frontend_pid=$!
  set +m
fi

echo ""
$run_panel  && echo "  console  →  http://localhost:$FRONTEND_PORT"
$run_engine && echo "  engine   →  http://localhost:$BACKEND_PORT/api/health"
echo ""
echo "  Order sending is a deploy decision: LIVE_TRADING in .env, not a click in the UI."
echo "  Ctrl+C stops everything started here."
echo ""

# Whichever side falls, take the other one down with it (the EXIT trap does the work).
# A half-running system misleads worse than a stopped one: the console stays up, the
# engine is gone, and frozen numbers keep looking current.
while true; do
  if $run_engine && ! kill -0 "$backend_pid" 2>/dev/null; then
    echo ""
    $run_panel && echo "the engine stopped — closing the console too." || echo "the engine stopped."
    break
  fi
  if $run_panel && ! kill -0 "$frontend_pid" 2>/dev/null; then
    echo ""
    $run_engine && echo "the console stopped — closing the engine too." || echo "the console stopped."
    break
  fi
  sleep 1
done
