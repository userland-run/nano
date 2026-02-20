#!/bin/bash
# Test all BusyBox applets through NanoVM
# Categories: PASS (exit 0-1, no crash), CRASH (WASM error), HANG (timeout), SKIP (interactive)

cd "$(dirname "$0")/.."

# Commands that expect stdin or are interactive shells - skip these
SKIP_CMDS="ash sh hush vi ed hexedit less more login su sulogin cttyhack vlock conspy getty microcom rx script scriptreplay chat"

# Commands that will block waiting for network/device - skip
SKIP_CMDS="$SKIP_CMDS acpid crond crontab dhcprelay dnsd ftpd httpd inetd ntpd syslogd telnetd tftpd udhcpd udpsvd tcpsvd klogd"

# Commands that need special hardware/device - skip
SKIP_CMDS="$SKIP_CMDS fbset fbsplash fgconsole loadfont loadkmap setfont setkeycodes setlogcons showkey switch_root"
SKIP_CMDS="$SKIP_CMDS i2cdetect i2cdump i2cget i2cset"
SKIP_CMDS="$SKIP_CMDS blockdev blkdiscard blkid fdisk losetup mkswap swapon swapoff"
SKIP_CMDS="$SKIP_CMDS insmod modinfo modprobe rmmod depmod"
SKIP_CMDS="$SKIP_CMDS halt poweroff reboot"
SKIP_CMDS="$SKIP_CMDS init linuxrc run-init"

PASS=0
FAIL=0
CRASH=0
TIMEOUT=0
SKIPPED=0
TOTAL=0

pass_list=""
fail_list=""
crash_list=""
timeout_list=""

while IFS= read -r cmd; do
    [ -z "$cmd" ] && continue
    TOTAL=$((TOTAL + 1))

    # Check if should skip
    skip=0
    for s in $SKIP_CMDS; do
        if [ "$cmd" = "$s" ]; then
            skip=1
            break
        fi
    done
    if [ $skip -eq 1 ]; then
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Run with 3 second timeout
    output=$(timeout 3 node test/run.mjs test/busybox --cmd "$cmd" 2>&1)
    exit_code=$?

    if [ $exit_code -eq 124 ]; then
        # Timeout
        TIMEOUT=$((TIMEOUT + 1))
        timeout_list="$timeout_list $cmd"
    elif echo "$output" | grep -q "CRASH\|RuntimeError\|memory access out of bounds"; then
        CRASH=$((CRASH + 1))
        crash_list="$crash_list $cmd"
    elif echo "$output" | grep -q "Unexpected status"; then
        FAIL=$((FAIL + 1))
        fail_list="$fail_list $cmd"
    else
        PASS=$((PASS + 1))
        pass_list="$pass_list $cmd"
    fi

done < /tmp/bb_applets.txt

echo ""
echo "========================================="
echo "  NanoVM BusyBox Applet Test Results"
echo "========================================="
echo "Total applets:  $TOTAL"
echo "Skipped:        $SKIPPED (interactive/daemon/hardware)"
echo "Tested:         $((TOTAL - SKIPPED))"
echo ""
echo "PASS:           $PASS"
echo "FAIL:           $FAIL"
echo "CRASH:          $CRASH"
echo "TIMEOUT:        $TIMEOUT"
echo ""

if [ -n "$crash_list" ]; then
    echo "--- CRASH (WASM error) ---"
    echo "$crash_list" | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' '
    echo ""
    echo ""
fi

if [ -n "$fail_list" ]; then
    echo "--- FAIL (unexpected VM status) ---"
    echo "$fail_list" | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' '
    echo ""
    echo ""
fi

if [ -n "$timeout_list" ]; then
    echo "--- TIMEOUT (>3s) ---"
    echo "$timeout_list" | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' '
    echo ""
    echo ""
fi

echo "--- PASS ($PASS applets) ---"
echo "$pass_list" | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' '
echo ""
