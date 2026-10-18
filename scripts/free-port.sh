#!/usr/bin/env bash
# Helpers for running several CI/QA jobs side by side in one container.
#   free_port            → prints a TCP port nobody is listening on (asks the kernel)
#   free_display         → prints an X display number with no Xvfb lock/socket
free_port() {
  node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})' 2>/dev/null \
    || python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'
}
free_display() {
  local n
  for n in $(seq "${1:-99}" 199); do
    [ -e "/tmp/.X$n-lock" ] || [ -e "/tmp/.X11-unix/X$n" ] || { echo "$n"; return 0; }
  done
  return 1
}
