# MCP Server + Chat UI (Vercel, no build)

This repo deploys:

- `api/mcp.js`: HTTP MCP JSON-RPC endpoint exposing Amello tools.
- `api/chat.js`: Chat backend that calls OpenAI and executes MCP tools automatically.
- `index.html`: Minimal chat UI.

## Deploy

1. Push this repo to GitHub.
2. Create a new Vercel project from this repo.
3. **Project Settings → General**
   - Framework Preset: **Other**
   - Build Command: **(empty)**
   - Install Command: **(empty)**
   - Output Directory: **(empty)**
4. **Environment Variables**
   - `OPENAI_API_KEY` = your key
   - (optional) `OPENAI_MODEL` = `gpt-4o-mini` (default)
   - (optional) `API_BASE` = `https://prod-api.amello.plusline.net/api/v1`
   - (optional) `AMELLO_API_TOKEN` = bearer token if Amello API requires it
5. Deploy.

## Verify MCP

Windows PowerShell:

```powershell
$Url = "https://<your-app>.vercel.app/api/mcp"

# tools/list
$List = @{ jsonrpc="2.0"; id=1; method="tools/list" } | ConvertTo-Json -Compress
Invoke-RestMethod -Method POST -Uri $Url -ContentType "application/json" -Body $List

# ping
$Ping = @{ jsonrpc="2.0"; id=2; method="tools/call"; params=@{ name="ping"; arguments=@{} } } | ConvertTo-Json -Compress
Invoke-RestMethod -Method POST -Uri $Url -ContentType "application/json" -Body $Ping

