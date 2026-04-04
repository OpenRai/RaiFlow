#!/bin/bash
# Nano RPC Health Probe - Improved April 2026

SERVERS=(
  "https://rpc.nano.to"
  "https://node.somenano.com/proxy"
  "https://rainstorm.city/api"
  "https://nanoslo.0x.no/proxy"
  "https://api.nanos.cc"
  # "https://proxy.nanos.cc/proxy"   # often dead
)

# Optional: Add your token here if using api.nanos.cc (get free/paid from their site)
# TOKEN="your-token-here"

echo "| server | request type | response | rtt |"
echo "|--------|--------------|----------|-----|"

for url in "${SERVERS[@]}"; do
  for action in "version" "block_count" "work_generate"; do

    if [ "$action" = "work_generate" ]; then
      payload='{"action":"work_generate","hash":"0000000000000000000000000000000000000000000000000000000000000000","difficulty":"fffffff800000000"}'
    else
      payload="{\"action\":\"$action\"}"
    fi

    # Add token if set and using nanos.cc
    extra_headers=""
    if [[ -n "$TOKEN" && "$url" == *"nanos.cc"* ]]; then
      extra_headers="-H \"Authorization: Bearer $TOKEN\""
    fi

    output=$(curl -s -m 10 \
      -H "Content-Type: application/json" \
      -H "User-Agent: Nano-Probe/2026" \
      $extra_headers \
      -d "$payload" \
      -w $'\n%{time_total}' \
      "$url" 2>&1)

    time_sec=$(echo "$output" | tail -n 1)
    response=$(echo "$output" | sed '$d')

    if ! echo "$time_sec" | grep -qE '^[0-9.]+$'; then
      time_sec="0"
      response="$output"
    fi

    rtt=$(awk "BEGIN {printf \"%.0f\", $time_sec * 1000}" 2>/dev/null || echo "0")

    clean_response=$(echo "$response" | tr -d '\n\r' | sed 's/|/\\|/g' | cut -c1-100)

    if [ -z "$clean_response" ] || echo "$response" | grep -qiE "error|timeout|failed|connection|refused|could not|401|403"; then
      clean_response="ERROR / TIMEOUT"
    elif echo "$response" | grep -q "{"; then
      if echo "$response" | grep -qE '"version"|"rpc_version"'; then
        clean_response="OK (version)"
      elif echo "$response" | grep -q '"count"'; then
        clean_response="OK"
      elif echo "$response" | grep -q '"work"'; then
        clean_response="OK (work)"
      else
        clean_response="OK"
      fi
    fi

    printf "| %s | %s | %s | %sms |\n" "$url" "$action" "$clean_response" "$rtt"
  done
done