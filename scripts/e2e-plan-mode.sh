#!/usr/bin/env bash
# End-to-end smoke test for plan mode, driven through the real TUI in tmux
# against the real configured provider (real LLM calls — costs tokens).
#
#   npm run e2e:plan
#
# Flow: launch → /plan → model writes a one-step plan + plan_done → approval
# dialog → "Approve and implement now" → model implements + plan_check → quit.
# Asserts on the terminal capture and on disk. Requires: tmux, a provider in
# ~/.cast/settings.json. Runs in an isolated HOME (provider creds copied in),
# so real sessions/plans/settings are never touched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOCK="cast-e2e-$$"
FAKE_HOME="$(mktemp -d)"
PROJ="$FAKE_HOME/proj"
CAPTURE() { tmux -L "$SOCK" capture-pane -p -S -200 -t e2e; }

cleanup() {
	tmux -L "$SOCK" kill-server 2>/dev/null || true
	rm -rf "$FAKE_HOME"
}
trap cleanup EXIT

fail() {
	echo "FAIL: $1"
	echo "--- last screen ---"
	CAPTURE | tail -30 || true
	exit 1
}

wait_for() { # wait_for <pattern> <timeout-seconds> <description>
	local deadline=$((SECONDS + $2))
	until CAPTURE | grep -q "$1"; do
		((SECONDS < deadline)) || fail "timeout waiting for: $3"
		sleep 2
	done
	echo "ok: $3"
}

send() { tmux -L "$SOCK" send-keys -t e2e "$@"; }
# The composer treats fast multi-char input as a bracketed paste; a second
# Enter after a beat submits it (harmless when the first already did).
say() {
	send "$1"
	sleep 2
	send Enter
	sleep 2
	send Enter
}

command -v tmux >/dev/null || { echo "SKIP: tmux not installed"; exit 0; }
[ -f "$HOME/.cast/settings.json" ] || { echo "SKIP: no provider configured (~/.cast/settings.json)"; exit 0; }

echo "== setup =="
mkdir -p "$PROJ" "$FAKE_HOME/.cast"
printf 'function greet(n) {\n\treturn `Hello, ${n}!`;\n}\nmodule.exports = { greet };\n' > "$PROJ/utils.js"
printf '# e2e\nTiny fixture project.\n' > "$PROJ/README.md"
node -e "
const fs = require('fs');
const real = JSON.parse(fs.readFileSync(process.env.HOME + '/.cast/settings.json', 'utf8'));
const minimal = { providerUrl: real.providerUrl, apiKey: real.apiKey, model: real.model, persona: 'coding' };
fs.writeFileSync('$FAKE_HOME/.cast/settings.json', JSON.stringify(minimal, null, '\t'));
"
(cd "$ROOT" && npm run build >/dev/null)

echo "== launch =="
tmux -L "$SOCK" new-session -d -s e2e -x 200 -y 50 -c "$PROJ" \
	"HOME='$FAKE_HOME' node '$ROOT/dist/index.js'; sleep 30"
wait_for '\[BUILD\]' 30 "TUI up in build mode"

echo "== plan phase =="
send "/plan"; sleep 1; send Enter; sleep 1
wait_for '\[PLAN\]' 15 "plan mode badge"
say "Write a one-step plan via plan_write named e2e-smoke: single checklist item '- [ ] add a farewell(n) function to utils.js returning \\\`Bye, \${n}!\\\` and export it'. Then call plan_done."
# The transcript "[Plan ready: …]" line lands mid-turn; the dialog itself only
# opens when the turn settles — wait for the dialog's own option text.
wait_for 'Plan ready: ' 180 "plan_done fired (path in transcript)"
wait_for 'Approve — switch to build and implement now' 60 "approval dialog open"

PLAN_FILE="$FAKE_HOME/.cast/plans"/*/e2e-smoke.md
grep -q '\- \[ \]' $PLAN_FILE || fail "plan file has no unchecked checklist item"
echo "ok: plan file on disk with checklist"

echo "== approve & implement =="
# "Keep planning" sits first now — step down to "Approve — switch to build and implement now".
send Down; sleep 1
send Enter
sleep 2
wait_for 'The plan is approved' 15 "auto-submitted approval message"
wait_for 'plan_check' 240 "implementation reached plan_check"
sleep 5

grep -q '\- \[x\]' $PLAN_FILE || fail "checklist item was not checked off"
grep -q 'farewell' "$PROJ/utils.js" || fail "utils.js was not modified per the plan"
node -e "const u=require('$PROJ/utils.js'); if(u.farewell('x')!=='Bye, x!') process.exit(1)" \
	|| fail "farewell() does not behave as planned"
echo "ok: step checked off, code works"

send "/quit"; sleep 1; send Enter; sleep 1
echo "PASS: plan mode e2e"
