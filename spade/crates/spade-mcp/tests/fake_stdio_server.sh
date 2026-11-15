#!/bin/sh
# A tiny MCP server on stdio for spade-mcp's tests: one JSON-RPC message per line.
# Tools: `env` shows its environment, `crash` exits, `spawn` starts a long sleep and gives its pid.
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/^{"jsonrpc":"2.0","id":\([0-9][0-9]*\).*/\1/p')
  version=$(printf '%s\n' "$line" | sed -n 's/.*"protocolVersion":"\([^"]*\)".*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"%s","capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"1"}}}\n' "$id" "$version" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"env","description":"Shows the environment","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}},{"name":"crash","inputSchema":{"type":"object"}},{"name":"spawn","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*'"name":"crash"'*)
      exit 3 ;;
    *'"method":"tools/call"'*'"name":"spawn"'*)
      sleep 300 &
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"%s"}]}}\n' "$id" "$!" ;;
    *'"method":"tools/call"'*)
      out=$(env | sort | tr '\n' ' ')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"%s"}]}}\n' "$id" "$out" ;;
    *)
      if [ -n "$id" ]; then printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"; fi ;;
  esac
done
