#!/bin/bash
# cast launcher.
#
# `node --import tsx` resolves the `tsx` package via node_modules lookup
# starting at the process's cwd, so we still have to `cd` into the source
# dir for that to work. But cast's own tools (bash/read/write/find/
# grep/ls) must operate relative to wherever the *caller* invoked this
# script from, not the source dir. CAST_CWD carries that distinction
# through to src/index.ts (see `cwd` resolution there).
ORIGINAL_CWD="$(pwd)"

# Resolve the real script location through any number of symlinks — both
# `npm link` and a global `npm install` put this file behind at least one
# (bin -> lib/node_modules/cast/cast.sh -> the actual repo dir), and
# `dirname "$0"` alone would resolve to the symlink's directory instead of
# where node_modules/tsx actually lives.
SOURCE="${BASH_SOURCE[0]:-$0}"
while [ -h "$SOURCE" ]; do
	DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
	SOURCE="$(readlink "$SOURCE")"
	[[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
cd "$SCRIPT_DIR"
set -a
source .env 2>/dev/null
set +a
exec env CAST_CWD="$ORIGINAL_CWD" node --import tsx ./src/index.ts "$@"
