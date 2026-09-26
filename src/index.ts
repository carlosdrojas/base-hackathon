import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ercotGet, API_BASE } from "./ercot-client.js";

const server = new McpServer({
  name: "ercot-mcp",
  version: "1.0.0",
});

function toolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function toolError(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

server.registerTool(
  "list_products",
  {
    title: "List ERCOT EMIL products",
    description:
      "List ERCOT public report products (EMIL products), e.g. real-time prices, day-ahead prices, load, generation, congestion. " +
      "Each product has an emilId used to fetch its data with get_report_data. Supports pagination and an optional client-side name search.",
    inputSchema: {
      page: z.number().int().positive().optional().describe("Page number, defaults to 1"),
      size: z.number().int().positive().max(1000).optional().describe("Page size, defaults to ERCOT's default"),
      search: z
        .string()
        .optional()
        .describe("Case-insensitive substring to filter products by name or emilId (applied after fetching)"),
    },
  },
  async ({ page, size, search }) => {
    try {
      const data = (await ercotGet(API_BASE, { page, size })) as any;
      if (search) {
        const needle = search.toLowerCase();
        const products = data?._embedded?.products ?? [];
        data._embedded.products = products.filter(
          (p: any) =>
            p.name?.toLowerCase().includes(needle) || p.emilId?.toLowerCase().includes(needle),
        );
      }
      return toolResult(data);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_product",
  {
    title: "Get an ERCOT EMIL product's details and report endpoints",
    description:
      "Fetch metadata for a single ERCOT EMIL product by its emilId, including the list of report artifact " +
      "endpoints to use with get_report_data.",
    inputSchema: {
      emilId: z.string().describe("EMIL product ID, e.g. 'NP6-905-CD' or 'NP4-190-CD'"),
    },
  },
  async ({ emilId }) => {
    try {
      const data = await ercotGet(`${API_BASE}/${encodeURIComponent(emilId.toLowerCase())}`);
      return toolResult(data);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_report_data",
  {
    title: "Get data from an ERCOT report artifact",
    description:
      "Fetch actual data rows from an ERCOT report artifact endpoint (the 'report' path segment shown in a " +
      "product's artifacts[]._links.endpoint.href from get_product, e.g. 'hourly_res_outage_cap'). " +
      "Accepts arbitrary query parameters (e.g. date filters, page, size) since they vary per report; " +
      "call get_product first to see the endpoint and consult ERCOT's docs for that report's specific filters.",
    inputSchema: {
      emilId: z.string().describe("EMIL product ID, e.g. 'NP6-905-CD'"),
      report: z.string().describe("Report path segment, e.g. 'hourly_res_outage_cap'"),
      query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Query parameters to pass through, e.g. { deliveryDateFrom: '2026-09-01', page: 1, size: 500 }"),
    },
  },
  async ({ emilId, report, query }) => {
    try {
      const path = `${API_BASE}/${encodeURIComponent(emilId.toLowerCase())}/${report}`;
      const data = await ercotGet(path, query);
      return toolResult(data);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_archive",
  {
    title: "Get historical archive listing for an ERCOT product",
    description:
      "List archived historical files for an EMIL product (older data not in the live report window).",
    inputSchema: {
      emilId: z.string().describe("EMIL product ID, e.g. 'NP6-905-CD'"),
      query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Query parameters, e.g. { page: 1, size: 100 }"),
    },
  },
  async ({ emilId, query }) => {
    try {
      const path = `${API_BASE}/archive/${encodeURIComponent(emilId.toLowerCase())}`;
      const data = await ercotGet(path, query);
      return toolResult(data);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "raw_get",
  {
    title: "Raw authenticated GET against the ERCOT Public API",
    description:
      "Escape hatch for calling any ERCOT Public API URL or path not covered by the other tools " +
      "(e.g. a full href copied from another response's _links). Adds auth headers automatically.",
    inputSchema: {
      pathOrUrl: z
        .string()
        .describe("Either a full https://api.ercot.com/... URL, or a path relative to /api/public-reports/"),
      query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Query parameters to append"),
    },
  },
  async ({ pathOrUrl, query }) => {
    try {
      const data = await ercotGet(pathOrUrl, query);
      return toolResult(data);
    } catch (error) {
      return toolError(error);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error starting ercot-mcp:", error);
  process.exit(1);
});
