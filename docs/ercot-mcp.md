# ercot-mcp

An MCP server that exposes the [ERCOT Public API](https://developer.ercot.com/) (prices, load, generation, congestion, outages) as tools for LLM agents. Built at the same hackathon as ARCA; it's a separate tool and isn't needed to run ARCA.

## 1. Register for an ERCOT Public API key (one-time, manual)

ERCOT requires email verification, so this step has to be done by a human in a browser — it can't be scripted.

1. Go to the [ERCOT API Explorer](https://apiexplorer.ercot.com/) and click **Sign In/Sign Up**.
2. Enter your email, retrieve the verification code from your inbox, and enter it.
3. Set a password and your name to finish creating the account.
4. Once signed in, go to **Products** in the top nav, select **Public API**, give the subscription a name (e.g. `Public API`), and click **Subscribe**.
5. On your **Profile** page, click **Show** next to the new subscription and copy the **Primary key** — this is your `ERCOT_SUBSCRIPTION_KEY`.

Full details: [Registration and Authentication docs](https://developer.ercot.com/applications/pubapi/user-guide/registration-and-authentication/).

## 2. Configure credentials

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

```
ERCOT_USERNAME=you@example.com          # the email you registered with
ERCOT_PASSWORD=your-account-password
ERCOT_SUBSCRIPTION_KEY=your-primary-key
```

The server exchanges your username/password for a short-lived (1 hour) ID token on demand and caches it in memory — there's no separate "API key" beyond the subscription key plus your account credentials.

## 3. Build and run

```bash
npm run build
npm start
```

This runs the MCP server over stdio.

## 4. Connect it to Claude Code / Claude Desktop

Add to your MCP config (e.g. `.mcp.json` in this repo, or Claude Desktop's config):

```json
{
  "mcpServers": {
    "ercot": {
      "command": "node",
      "args": ["/absolute/path/to/base-hackathon/dist/index.js"],
      "env": {
        "ERCOT_USERNAME": "you@example.com",
        "ERCOT_PASSWORD": "your-account-password",
        "ERCOT_SUBSCRIPTION_KEY": "your-primary-key"
      }
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `list_products` | List ERCOT EMIL products (report categories) with pagination and name search |
| `get_product` | Get one product's metadata and its report endpoints, by `emilId` |
| `get_report_data` | Fetch actual data rows from a report artifact, with arbitrary query params (date filters, paging) |
| `get_archive` | List historical archive files for a product beyond the live report window |
| `raw_get` | Escape hatch: authenticated GET against any ERCOT Public API URL/path |

Typical flow: `list_products` (search e.g. "LMP" or "load") → `get_product` for the `emilId` you want → `get_report_data` with that product's report path segment and any date filters.

## Notes

- ERCOT's `Coming Soon` docs mean per-report query parameters (date filters, etc.) aren't uniformly documented — `get_product` returns each report's endpoint URL, and `get_report_data`/`raw_get` pass through any query params you give them.
- Report and data field names vary per EMIL product; ERCOT's [data product catalog](https://www.ercot.com/mp/data-products) is useful for figuring out what a given `emilId` contains.
