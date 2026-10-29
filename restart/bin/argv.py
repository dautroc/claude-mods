# argv.py PID... prints a JSON list holding each process's argument vector,
# exactly as it was started (no word joined or split again, as `ps` does),
# read from the kernel with sysctl KERN_PROCARGS2. macOS only.
import ctypes
import ctypes.util
import json
import struct
import sys

CTL_KERN = 1
KERN_ARGMAX = 8
KERN_PROCARGS2 = 49

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)


def argmax():
    value = ctypes.c_int(0)
    size = ctypes.c_size_t(ctypes.sizeof(value))
    mib = (ctypes.c_int * 2)(CTL_KERN, KERN_ARGMAX)
    if libc.sysctl(mib, 2, ctypes.byref(value), ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "sysctl KERN_ARGMAX")
    return value.value


def argv(pid, limit):
    buffer = ctypes.create_string_buffer(limit)
    size = ctypes.c_size_t(limit)
    mib = (ctypes.c_int * 3)(CTL_KERN, KERN_PROCARGS2, pid)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), f"sysctl KERN_PROCARGS2 {pid}")
    data = buffer.raw[: size.value]
    # argc, the executable's path, the NULs padding it, then argv.
    (argc,) = struct.unpack("i", data[:4])
    rest = data[4:]
    rest = rest[rest.index(b"\0") :].lstrip(b"\0")
    return [arg.decode("utf-8", "surrogateescape") for arg in rest.split(b"\0")[:argc]]


limit = argmax()
print(json.dumps([argv(int(pid), limit) for pid in sys.argv[1:]]))
