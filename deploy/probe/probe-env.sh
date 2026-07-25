#!/bin/sh
# GATE 1 — what the Cloudflare Container sandbox actually is.
#
# Every question docs/substrates-cloudflare.md marks unverified about the
# runtime environment, answered with real command output. Nothing here fails
# the script: this is measurement, and a refusal IS the result.

echo "===== 1. kernel and root filesystem ====="
echo "\$ uname -a";               uname -a
echo "\$ uname -r";               uname -r
echo "\$ stat -f -c %T /";        stat -f -c %T /
echo "\$ stat -f -c %T /work";    stat -f -c %T /work 2>&1
echo "\$ stat -f -c %T /tmp";     stat -f -c %T /tmp 2>&1
echo "\$ nproc";                  nproc
echo "\$ cat /proc/meminfo | head -3"; head -3 /proc/meminfo
echo "\$ df -h /";                df -h / 2>&1
echo "\$ cat /proc/mounts";       cat /proc/mounts

echo
echo "===== 2. identity ====="
echo "\$ id";                     id
echo "\$ cat /proc/self/uid_map"; cat /proc/self/uid_map 2>&1
echo "\$ cat /proc/self/gid_map"; cat /proc/self/gid_map 2>&1
echo "\$ cat /proc/self/setgroups"; cat /proc/self/setgroups 2>&1
echo "\$ readlink /proc/self/ns/user"; readlink /proc/self/ns/user 2>&1
echo "\$ readlink /proc/self/ns/pid";  readlink /proc/self/ns/pid 2>&1
echo "\$ readlink /proc/self/ns/mnt";  readlink /proc/self/ns/mnt 2>&1
echo "\$ ps -eo pid,user,args (PID namespace check)"; ps -eo pid,user,args 2>&1 | head -20

echo
echo "===== 3. capabilities ====="
echo "\$ capsh --print"
capsh --print 2>&1
echo "--- raw, from /proc/self/status (authoritative) ---"
grep -E '^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs|Seccomp|Groups|Uid|Gid)' /proc/self/status 2>&1
echo "\$ capsh --decode of CapBnd"
capsh --decode=$(awk '/^CapBnd/{print $2}' /proc/self/status) 2>&1

echo
echo "===== 4. FUSE ====="
echo "\$ ls -l /dev/fuse";        ls -l /dev/fuse 2>&1
echo "\$ ls /dev";                ls /dev 2>&1
echo "\$ which fusermount3 fusermount"; which fusermount3 fusermount 2>&1
echo "\$ cat /proc/filesystems | grep -i fuse"; grep -i fuse /proc/filesystems 2>&1
echo "\$ test -w /dev/fuse"; if [ -w /dev/fuse ]; then echo "WRITABLE"; else echo "not writable / absent"; fi

echo
echo "===== 5. user namespaces and overlayfs ====="
echo "\$ cat /proc/sys/user/max_user_namespaces"; cat /proc/sys/user/max_user_namespaces 2>&1
echo "\$ cat /proc/sys/kernel/unprivileged_userns_clone"; cat /proc/sys/kernel/unprivileged_userns_clone 2>&1
echo "\$ unshare -Urm id"
unshare -Urm id 2>&1
echo "rc=$?"
echo "\$ unshare -Urm sh -c 'mount -t overlay ...'"
unshare -Urm sh -c '
  set -x
  mkdir -p /tmp/ovl/lower /tmp/ovl/upper /tmp/ovl/wd /tmp/ovl/merged
  echo hello > /tmp/ovl/lower/a.txt
  mount -t overlay overlay -o lowerdir=/tmp/ovl/lower,upperdir=/tmp/ovl/upper,workdir=/tmp/ovl/wd /tmp/ovl/merged
  rc=$?
  set +x
  if [ $rc -eq 0 ]; then
    echo "OVERLAY MOUNT: OK"
    cat /tmp/ovl/merged/a.txt
    echo written-through > /tmp/ovl/merged/b.txt && echo "OVERLAY WRITE: OK"
    ls -l /tmp/ovl/upper
    umount /tmp/ovl/merged && echo "OVERLAY UMOUNT: OK"
  else
    echo "OVERLAY MOUNT: FAILED rc=$rc"
  fi
' 2>&1
echo "\$ unshare -Urm sh -c 'mount -t tmpfs' (control: does ANY mount work)"
unshare -Urm sh -c 'mkdir -p /tmp/tm && mount -t tmpfs tmpfs /tmp/tm && echo "TMPFS MOUNT: OK" && umount /tmp/tm' 2>&1
echo "\$ mount -t tmpfs WITHOUT unshare (control)"
sh -c 'mkdir -p /tmp/tm2 && mount -t tmpfs tmpfs /tmp/tm2 && echo "BARE TMPFS MOUNT: OK"' 2>&1

echo
echo "===== 6. privilege probes relevant to restore fidelity ====="
d=$(mktemp -d)
echo test > "$d/f"
echo "\$ chown 1001:1001 f"; chown 1001:1001 "$d/f" 2>&1; echo "rc=$?"
echo "\$ chgrp 1001 f";      chgrp 1001 "$d/f" 2>&1; echo "rc=$?"
echo "\$ chmod 4755 f";      chmod 4755 "$d/f" 2>&1; echo "rc=$?"; stat -c '%A %a %U:%G' "$d/f"
echo "\$ chmod 2755 f";      chmod 2755 "$d/f" 2>&1; echo "rc=$?"; stat -c '%A %a %U:%G' "$d/f"
echo "\$ mkdir sticky && chmod 1777"; mkdir -p "$d/sticky" && chmod 1777 "$d/sticky" 2>&1; echo "rc=$?"; stat -c '%A %a' "$d/sticky"
echo "\$ mknod null0 c 1 3";  mknod "$d/null0" c 1 3 2>&1; echo "rc=$?"
echo "\$ mkfifo pipe";        mkfifo "$d/pipe" 2>&1; echo "rc=$?"; ls -l "$d/pipe" 2>&1
echo "\$ ln -s target link && ln f hard"; ln -s target "$d/link" 2>&1; ln "$d/f" "$d/hard" 2>&1; echo "rc=$?"; ls -l "$d" 2>&1
rm -rf "$d"

echo
echo "===== 7. misc platform facts ====="
echo "\$ cat /etc/os-release"; cat /etc/os-release 2>&1 | head -4
echo "\$ ulimit -a"; ulimit -a 2>&1
echo "\$ cat /proc/self/limits"; cat /proc/self/limits 2>&1 | head -12
echo "\$ ls /sys/fs/cgroup | head"; ls /sys/fs/cgroup 2>&1 | head
echo "\$ date -u +%Y-%m-%dT%H:%M:%SZ"; date -u +%Y-%m-%dT%H:%M:%SZ
echo "===== END ====="
