#!/bin/sh
# Invoked only by the trusted namespace launcher; never pass model strings as commands.
set -eu
root=$1
snapshot=$2
modules=$3
preset=$4
mount --make-rprivate /
mount -t tmpfs -o size=96m,nosuid,nodev tmpfs "$root"
mkdir "$root/usr" "$root/project" "$root/proc" "$root/tmp" "$root/dev" "$root/empty" "$root/etc" "$root/input"
chmod 1777 "$root/tmp"
for d in bin sbin lib lib64; do
  if [ -d "/usr/$d" ]; then ln -s "usr/$d" "$root/$d"; fi
done
mount --bind /usr "$root/usr"
mount -o remount,bind,ro,nosuid,nodev "$root/usr"
# Copy from the read-only input into the size-bounded tmpfs; project code
# cannot fill or modify the host filesystem (including via generated files).
mount --bind "$snapshot" "$root/input"
mount -o remount,bind,ro,nosuid,nodev "$root/input"
cp -R "$root/input/." "$root/project/"
umount "$root/input"
if [ "$modules" != '-' ]; then
  mkdir "$root/project/node_modules"
  mount --bind "$modules" "$root/project/node_modules"
  mount -o remount,bind,ro,nosuid,nodev "$root/project/node_modules"
fi
mount -t proc -o ro,nosuid,nodev,noexec proc "$root/proc"
# No host /dev, /run, /home, /var, application files, credential mounts or network.
# Low file-size, memory and CPU ceilings complement process/PID isolation.
case "$preset" in
  test) set -- npm --ignore-scripts run test ;;
  build) set -- npm --ignore-scripts run build ;;
  node-test) set -- node --test ;;
  *) exit 64 ;;
esac
exec /usr/sbin/chroot "$root" /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
  /usr/bin/prlimit --as=3221225472 --cpu=20 --nproc=96 --nofile=128 --fsize=16777216 --core=0 -- \
  /bin/sh -c 'cd /project; exec "$@"' sandbox "$@"
