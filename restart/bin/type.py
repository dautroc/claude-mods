# type.py SHELL_PID LINE types LINE and Return into the terminal this process
# shares with the shell, as if typed (TIOCSTI), for any terminal.
#
# The helper that runs this was started in Claude Code's process group, which
# is orphaned once Claude Code exits, and the terminal answers EIO to that
# group. Joining the shell's group first is what lets the ioctl through.
import fcntl
import os
import sys
import termios

os.setpgid(0, int(sys.argv[1]))
tty = os.open("/dev/tty", os.O_RDWR)
for byte in (sys.argv[2] + "\n").encode():
    fcntl.ioctl(tty, termios.TIOCSTI, bytes([byte]))
