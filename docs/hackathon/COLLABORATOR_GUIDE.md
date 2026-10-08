# Using ercot-mcp — guide for collaborators

This gets you set up to query live ERCOT grid data (prices, load, generation,
congestion, outages) as tools inside Claude Code / Claude Desktop.

Everyone needs their **own** ERCOT account and subscription key — don't share
credentials, they're tied to your email.

## 1. Clone and install

```bash
git clone https://github.com/maria0406/base-hackathon.git
cd base-hackathon
npm install
```

## 2. Get your own ERCOT API key

1. Go to https://apiexplorer.ercot.com/ and click **Sign In/Sign Up**.
2. Sign up with your email, verify the code sent to your inbox, set a password.
3. Go to **Products** → **Public API** → give the subscription a name (e.g.
   `Public API`) → **Subscribe**.
4. On your **Profile** page, click **Show** next to the subscription and copy
   the **Primary key**.

## 3. Configure credentials

```bash
cp .env.example .env
```

Fill in `.env` with your own values:

```
ERCOT_USERNAME=you@example.com
ERCOT_PASSWORD=your-ercot-account-password
ERCOT_SUBSCRIPTION_KEY=your-primary-key
```

This file is gitignored — it never gets committed or shared.

## 4. Build

```bash
npm run build
```

## 5. Connect it to Claude Code

Easiest way — run this from the repo root (uses your absolute path
automatically):

```bash
claude mcp add ercot -- node "$(pwd)/dist/index.js"
```

Then set the three env vars for that server (Claude Code will prompt, or edit
your user-level MCP config directly) so it matches your `.env` values. If you
prefer to edit the config by hand, add:

```json
{
  "mcpServers": {
    "ercot": {
      "command": "node",
      "args": ["/absolute/path/to/base-hackathon/dist/index.js"],
      "env": {
        "ERCOT_USERNAME": "you@example.com",
        "ERCOT_PASSWORD": "your-ercot-account-password",
        "ERCOT_SUBSCRIPTION_KEY": "your-primary-key"
      }
    }
  }
}
```

For Claude Desktop, add the same block to its MCP config file instead.

Restart Claude Code / Desktop after adding it.

## 6. Try it out

Once connected, ask Claude things like:

- "List ERCOT products with 'LMP' in the name" → uses `list_products`
- "Get the report endpoints for emilId NP6-905-CD" → uses `get_product`
- "Pull real-time settlement point prices for the last 24 hours" →
  `get_report_data` with date-filtered query params
- "What historical archive files exist for NP4-183-CD?" → `get_archive`

## Troubleshooting

- **"Missing required environment variable ..."** — your `.env` (or MCP config
  `env` block) is missing a value.
- **"ERCOT authentication failed (401)"** — wrong username/password, or your
  ERCOT account needs email verification finished.
- **"ERCOT API request ... failed (401/403)"** on a specific call — check
  you're subscribed to the **Public API** product (step 2.3), not just signed
  up.
- Report/query parameter names aren't fully documented by ERCOT — call
  `get_product` first to see a report's endpoint, and cross-check against
  ERCOT's [data product catalog](https://www.ercot.com/mp/data-products).
