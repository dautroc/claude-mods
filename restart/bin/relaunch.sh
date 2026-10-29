#!/bin/sh
# relaunch.sh CLAUDE_PID SHELL_PID SESSION_ID LINE [MADO_SESSION MADO_PANE]
#
# Started detached by the restart mod just before it runs /exit. Waits for
# that Claude Code to end, then types LINE into the shell it ran from: through
# Mado when the session runs in a Mado pane, else with type.py. What it says
# is the log the mod names.
claude=$1 shell=$2 id=$3 line=$4 mado_session=$5 mado_pane=$6
here=$(dirname "$0")

say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }

# --expect-fg: only once the shell holds the pane's foreground again.
through_mado() {
  [ -n "$mado_session" ] && [ -n "$mado_pane" ] || return 1
  tries=0
  until mado send -s "$mado_session" -p "$mado_pane" --expect-fg "$shell" --paste "$line" --key return; do
    tries=$((tries + 1))
    [ "$tries" -ge 20 ] && return 1
    sleep 0.1
  done
}

say "waiting for Claude Code ($claude) to exit"
waited=0
while kill -0 "$claude" 2>/dev/null; do
  sleep 0.1
  waited=$((waited + 1))
  # /exit may wait on a question of its own; past a minute, an exit made by
  # hand later should not start Claude Code again.
  if [ "$waited" -ge 600 ]; then
    say "still running after 60 s; giving up"
    exit 1
  fi
done
say "exited after about $((waited * 100)) ms"

if through_mado; then
  say "typed through Mado"
  exit 0
fi
[ -n "$mado_session" ] && say "mado send failed; typing on the terminal instead"
if /usr/bin/python3 -I "$here/type.py" "$shell" "$line"; then
  say "typed on the terminal"
  exit 0
fi

say "couldn't type the command"
printf '\nClaude Code could not start again by itself. To resume this session, run:\n  claude --resume %s\n\n' "$id" >/dev/tty 2>/dev/null
exit 1
