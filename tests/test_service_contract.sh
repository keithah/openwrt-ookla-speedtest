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
out=$(printf '%s\n' '{"method":"status"}' | "$SVC"); echo "$out" | grep -q '"state"'
printf '%s\n' '{"method":"settings"}' | "$SVC" | grep -q '"terms_accepted":false'
printf '%s\n' '{"method":"start","server_id":"42"}' | "$SVC" | grep -q 'terms_required'
printf '%s\n' '{"method":"accept_terms"}' | "$SVC" | grep -q '"ok":true'
[ -f "$ROOT/etc/terms-accepted" ]
printf '%s\n' '{"method":"settings"}' | "$SVC" | grep -q '"terms_accepted":true'
out=$(printf '%s\n' '{"method":"start","server_id":"42"}' | "$SVC"); echo "$out" | grep -q '"ok":true'
[ -s "$OOKLA_WEBD_HISTORY" ]
out=$(printf '%s\n' '{"method":"history"}' | "$SVC"); echo "$out" | grep -q '"items"'
out=$(printf '%s\n' '{"method":"local_download","bytes":1024}' | "$SVC"); echo "$out" | grep -q '"bytes":1024'; echo "$out" | grep -q '"data"'
out=$(printf '%s\n' '{"method":"local_upload","data":"01234567"}' | "$SVC"); echo "$out" | grep -q '"bytes":8'
printf '%s\n' '{"method":"local_download","bytes":9999999}' | "$SVC" | grep -q 'invalid_transfer_size'
out=$(printf '%s\n' '{"method":"record_local","download_mbps":125.5,"upload_mbps":80.2,"ping_ms":3.1}' | "$SVC"); echo "$out" | grep -q '"ok":true'
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
