#!/bin/sh
# The emulator part of ai-diag.yml (one shell, so background loggers live through all the runs).
# Usage: sh tests/e2e/android-run.sh <model, e.g. base-q8_0>
M=$1
X=$2 # more engine settings for every run, e.g. ,"beam":2
# let the freshly booted system finish its background work (dex optimisation) before timing anything
for i in $(seq 1 24); do l=$(adb shell cat /proc/loadavg | cut -d' ' -f1); [ "${l%%.*}" -lt 3 ] && break; sleep 5; done; echo "load $l"
adb logcat -c
stdbuf -oL adb logcat -v time -b main -b system -b crash -b kernel '*:W' TilawaWhisper:V ActivityManager:I > logcat.txt 2>&1 &
(while true; do echo "$(date +%T) host: $(free -m | awk 'NR==2{print "used",$3,"avail",$7}') load $(cut -d' ' -f1 /proc/loadavg); guest: $(adb shell cat /proc/meminfo 2>/dev/null | awk '/MemAvailable/{print "avail",$2}') $(adb shell cat /proc/loadavg 2>/dev/null | cut -d' ' -f1)"; sleep 5; done) > mem.txt 2>&1 &
alive() { if pgrep -f qemu-system > /dev/null; then echo "emulator alive"; else echo "EMULATOR GONE"; fi; }
run() { timeout 420 env ANDROID=1 "$@" node tests/e2e/ai-browser.cjs; echo "exit $?"; alive; }
run FAKE_MIC=/diag.wav SECONDS=150 CLIPS=1 NATIVE="{\"model\":\"$M\",\"margin\":1$X}"
run FAKE_MIC=/diag2.wav SECONDS=150 NATIVE="{\"model\":\"$M\",\"margin\":1$X}"
run FAKE_MIC=/diag.wav SECONDS=150 NATIVE="{\"model\":\"$M\",\"margin\":-1$X}"
run FAKE_MIC=/diag.wav SECONDS=3 CLIPS=1 NATIVE="{\"model\":\"$M\",\"margin\":1,\"threads\":4}" 2>&1 | grep -E 'CLIPS|ctx|full window|Qur’an model|exit|emulator|EMULATOR'
run FAKE_MIC=/diag2.wav SECONDS=150 NATIVE="{\"model\":\"$M\",\"margin\":-1$X}"
echo "--- memory"; tail -8 mem.txt
echo "--- host kernel"; sudo dmesg | tail -20
echo "--- emulator crash reports"; ls -la /tmp/android-runner/ 2>/dev/null; ls -la ~/.android/ 2>/dev/null | head
echo "--- logcat"; grep -E 'TilawaWhisper|AndroidRuntime|FATAL|lowmemory|ActivityManager: (Kill|Process)' logcat.txt | grep -v 'whisper_model_load\|whisper_init\|whisper_backend' | tail -40
kill %1 %2 2>/dev/null
exit 0
