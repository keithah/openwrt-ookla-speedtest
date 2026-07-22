#!/bin/sh
set -eu
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/run" "$ROOT/etc" "$ROOT/bin"
cat > "$ROOT/bin/speedtest" <<'SH'
#!/bin/sh
printf '%s' '{"type":"result","ping":{"latency":12},"download":{"bandwidth":1000000},"upload":{"bandwidth":500000},"server":{"id":42,"name":"Test","sponsor":"Acme","location":"Town"},"isp":"ISP"}'
SH
chmod +x "$ROOT/bin/speedtest"
export OOKLA_WEBD_RUN_DIR="$ROOT/run" OOKLA_WEBD_HISTORY="$ROOT/etc/history.jsonl" OOKLA_SPEEDTEST_BIN="$ROOT/bin/speedtest"
SVC=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)/package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd
RPC=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)/package/luci-app-ookla-speedtest-web/usr/libexec/rpcd/ookla-speedtest-web
"$RPC" list | grep -q '"local_download"'
"$RPC" list | grep -q '"begin_local"'
"$RPC" list | grep -q '"cancel_local"'
out=$(printf '%s\n' '{}' | OOKLA_WEBD_HELPER="$SVC" "$RPC" call begin_local)
bridge_run_id=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')
printf '{"run_id":"%s","bytes":1024}\n' "$bridge_run_id" | OOKLA_WEBD_HELPER="$SVC" "$RPC" call local_download | grep -q '"bytes":1024'
printf '{"run_id":"%s"}\n' "$bridge_run_id" | OOKLA_WEBD_HELPER="$SVC" "$RPC" call cancel_local | grep -q '"state":"cancelled"'
out=$(printf '%s\n' '{"method":"status"}' | "$SVC"); echo "$out" | grep -q '"state"'
printf '%s\n' '{"method":"settings"}' | "$SVC" | grep -q '"terms_accepted":false'
printf '%s\n' '{"method":"start","server_id":"42"}' | "$SVC" | grep -q 'terms_required'
printf '%s\n' '{"method":"accept_terms"}' | "$SVC" | grep -q '"ok":true'
[ -f "$ROOT/etc/terms-accepted" ]
printf '%s\n' '{"method":"settings"}' | "$SVC" | grep -q '"terms_accepted":true'
out=$(printf '%s\n' '{"method":"start","server_id":"42"}' | "$SVC"); echo "$out" | grep -q '"ok":true'
[ -s "$OOKLA_WEBD_HISTORY" ]
out=$(printf '%s\n' '{"method":"start_live","server_id":"42"}' | "$SVC"); echo "$out" | grep -Eq '"job_id":"[0-9a-f]{32}"'
job_id=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["job_id"])')
live=''
i=0
while [ "$i" -lt 100 ]; do
 live=$(printf '{"method":"live_status","job_id":"%s"}\n' "$job_id" | "$SVC")
 echo "$live" | grep -q '"state":"complete"' && break
 i=$((i+1)); sleep .05
done
echo "$live" | grep -q '"state":"complete"'
echo "$live" | grep -q '"id":42'
printf '%s\n' '{"method":"live_status","job_id":"../bad"}' | "$SVC" | grep -q 'invalid_job_id'
sleep .05
out=$(printf '%s\n' '{"method":"history"}' | "$SVC"); echo "$out" | grep -q '"items"'
out=$(printf '%s\n' '{"method":"begin_local"}' | "$SVC"); echo "$out" | grep -Eq '"run_id":"[0-9a-f]{32}"'
local_run_id=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')
out=$(printf '{"method":"local_download","run_id":"%s","bytes":1024}\n' "$local_run_id" | "$SVC"); echo "$out" | grep -q '"bytes":1024'; echo "$out" | grep -q '"data"'
out=$(printf '{"method":"local_upload","run_id":"%s","data":"01234567"}\n' "$local_run_id" | "$SVC"); echo "$out" | grep -q '"bytes":8'
printf '{"method":"local_download","run_id":"%s","bytes":9999999}\n' "$local_run_id" | "$SVC" | grep -q 'invalid_transfer_size'
out=$(printf '{"method":"record_local","run_id":"%s","download_mbps":125.5,"upload_mbps":80.2,"ping_ms":3.1}\n' "$local_run_id" | "$SVC"); echo "$out" | grep -q '"state":"committed"'
printf '%s\n' '{"method":"history"}' | "$SVC" | grep -q '"kind":"device-router"'
out=$(printf '%s\n' '{"method":"start","server_id":"x"}' | "$SVC" || true); echo "$out" | grep -q 'invalid_server_id'
printf '%s\n' '{"method":"clear_history"}' | "$SVC" | grep -q '"ok":true'
# malformed output
printf '#!/bin/sh\nprintf x > /dev/stdout\n' > "$ROOT/bin/speedtest"; chmod +x "$ROOT/bin/speedtest"
printf '%s\n' '{"method":"start"}' | "$SVC" | grep -q 'malformed_output'
# busy lock
mkdir "$ROOT/run/start.lock.d"; rmdir "$ROOT/run/start.lock.d"
# busy lock held with flock
python3 -c 'import fcntl,time; f=open("'$ROOT'/run/start.lock","w"); fcntl.flock(f,fcntl.LOCK_EX); time.sleep(2)' & LP=$!; sleep .3
printf '%s\n' '{"method":"start"}' | "$SVC" | grep -q 'busy'; kill $LP 2>/dev/null || true
# oversized output
cat > "$ROOT/bin/speedtest" <<'SH'
#!/bin/sh
python3 -c 'print("x" * 1100000)'
SH
chmod +x "$ROOT/bin/speedtest"
printf '%s\n' '{"method":"start"}' | "$SVC" | grep -q 'output_too_large'
# server discovery success then error
printf '#!/bin/sh\nprintf "{\\"servers\\":[{\\"id\\":7}]}"\n' > "$ROOT/bin/speedtest"; chmod +x "$ROOT/bin/speedtest"
printf '%s\n' '{"method":"servers"}' | "$SVC" | grep -q '"id":7'
# cached discovery should not invoke the binary again
printf '#!/bin/sh\nexit 99\n' > "$ROOT/bin/speedtest"; chmod +x "$ROOT/bin/speedtest"
printf '%s\n' '{"method":"servers"}' | "$SVC" | grep -q '"id":7'
rm -f "$ROOT/run/servers-cache.json"
printf '#!/bin/sh\nprintf bad\n' > "$ROOT/bin/speedtest"; chmod +x "$ROOT/bin/speedtest"
printf '%s\n' '{"method":"servers"}' | "$SVC" | grep -q 'server_error'
# nonzero valid JSON
printf '#!/bin/sh\nprintf "{}"; exit 3\n' > "$ROOT/bin/speedtest"; chmod +x "$ROOT/bin/speedtest"
printf '%s\n' '{"method":"start"}' | "$SVC" | grep -q 'speedtest_failed'
# retention bound
export OOKLA_HISTORY_RETENTION=1
printf '%s\n' '{"method":"clear_history"}' | "$SVC" >/dev/null
printf '%s\n' '{"method":"start"}' | "$SVC" >/dev/null || true
printf '%s\n' '{"method":"start"}' | "$SVC" >/dev/null || true
[ "$(wc -l < "$OOKLA_WEBD_HISTORY")" -le 1 ]
