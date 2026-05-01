#!/usr/bin/env node
/**
 * Datto SaaS Protection MCP Server
 *
 * This MCP server provides tools for interacting with the Datto SaaS
 * Protection (Backupify) API. It accepts credentials via environment
 * variables (env mode) or per-request HTTP headers (gateway mode).
 *
 * Supports both stdio (default) and HTTP (StreamableHTTP) transports.
 */

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DattoSaasProtectionClient } from "@wyre-technology/node-datto-saas-protection";
import { setServerRef } from "./utils/server-ref.js";
import { elicitConfirmation, elicitSelection, elicitText } from "./utils/elicitation.js";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface DattoSaasCredentials {
  apiKey: string;
  region?: string;
}

function getCredentials(): DattoSaasCredentials | null {
  const apiKey = process.env.DATTO_SAAS_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    region: process.env.DATTO_SAAS_REGION || "us",
  };
}

function createClient(creds: DattoSaasCredentials): DattoSaasProtectionClient {
  return new DattoSaasProtectionClient({
    apiKey: creds.apiKey,
    region: (creds.region as "us" | "eu") || "us",
  });
}

// ---------------------------------------------------------------------------
// Server factory — fresh server per request (stateless HTTP mode)
// ---------------------------------------------------------------------------

function createMcpServer(credentialOverrides?: DattoSaasCredentials): Server {
  const server = new Server(
    {
      name: "datto-saas-protection-mcp",
      version: "0.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  setServerRef(server);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "datto_saas_list_clients",
          description: "List all customer organizations protected by Datto SaaS Protection.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Max results (default: 100)", default: 100 },
            },
          },
        },
        {
          name: "datto_saas_list_domains",
          description:
            "List protected domains under a client. If clientId is omitted, the user will be prompted to pick one.",
          inputSchema: {
            type: "object",
            properties: {
              clientId: { type: "string", description: "Client identifier (optional — will elicit if omitted)" },
            },
          },
        },
        {
          name: "datto_saas_list_seats",
          description:
            "List seats (mailboxes/users) in a domain. Toggle includeArchived to see deactivated seats.",
          inputSchema: {
            type: "object",
            properties: {
              clientId: { type: "string", description: "Client identifier" },
              domainId: { type: "string", description: "Domain identifier" },
              includeArchived: {
                type: "boolean",
                description: "Include archived seats (optional — will elicit if omitted)",
              },
            },
            required: ["clientId", "domainId"],
          },
        },
        {
          name: "datto_saas_get_seat",
          description: "Get details for a single seat by ID.",
          inputSchema: {
            type: "object",
            properties: {
              seatId: { type: "string", description: "Seat identifier" },
            },
            required: ["seatId"],
          },
        },
        {
          name: "datto_saas_list_backups",
          description: "List backup runs / snapshots for a seat.",
          inputSchema: {
            type: "object",
            properties: {
              seatId: { type: "string", description: "Seat identifier" },
            },
            required: ["seatId"],
          },
        },
        {
          name: "datto_saas_queue_restore",
          description:
            "Queue a restore for a seat. DESTRUCTIVE: writes data back into the target tenant. The destination user must have appropriate Microsoft Graph / Google API permissions for the restore to land. Requires explicit confirmation.",
          inputSchema: {
            type: "object",
            properties: {
              seatId: { type: "string", description: "Seat identifier to restore from" },
              items: {
                type: "array",
                description: "Items (folder/message/file IDs) to restore. Pass an empty array to restore the entire seat.",
                items: { type: "string" },
              },
            },
            required: ["seatId", "items"],
          },
        },
        {
          name: "datto_saas_get_restore_status",
          description: "Check the status / progress of a queued restore.",
          inputSchema: {
            type: "object",
            properties: {
              restoreId: { type: "string", description: "Restore job identifier" },
            },
            required: ["restoreId"],
          },
        },
        {
          name: "datto_saas_list_activity",
          description:
            "List activity log entries for a client. If date range is omitted, the user will be prompted.",
          inputSchema: {
            type: "object",
            properties: {
              clientId: { type: "string", description: "Client identifier" },
              since: { type: "string", description: "ISO 8601 start datetime (optional)" },
              until: { type: "string", description: "ISO 8601 end datetime (optional)" },
            },
            required: ["clientId"],
          },
        },
        {
          name: "datto_saas_get_license_usage",
          description: "Get license usage / seat counts vs purchased for a client.",
          inputSchema: {
            type: "object",
            properties: {
              clientId: { type: "string", description: "Client identifier" },
            },
            required: ["clientId"],
          },
        },
      ],
    };
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const DATE_FILTER_PAGE_CAP = 2000;

  interface DateRangeMs {
    sinceMs?: number;
    untilMs?: number;
  }

  function normalizeTs(raw: number): number {
    return raw < 1e12 ? raw * 1000 : raw;
  }

  function filterByDate<T extends { createdAt?: number | string; timestamp?: number | string }>(
    items: T[],
    range: DateRangeMs
  ): T[] {
    const sinceMs = range.sinceMs ?? -Infinity;
    const untilMs = range.untilMs ?? Infinity;
    const out: T[] = [];
    for (const item of items) {
      const raw = item.createdAt ?? item.timestamp;
      if (raw != null) {
        const numeric = typeof raw === "string" ? Date.parse(raw) : normalizeTs(raw);
        if (!Number.isNaN(numeric) && (numeric < sinceMs || numeric > untilMs)) continue;
      }
      out.push(item);
      if (out.length >= DATE_FILTER_PAGE_CAP) break;
    }
    return out;
  }

  async function resolveDateRange(
    args: { since?: string; until?: string }
  ): Promise<DateRangeMs> {
    if (args.since || args.until) {
      return {
        sinceMs: args.since ? new Date(args.since).getTime() : undefined,
        untilMs: args.until ? new Date(args.until).getTime() : undefined,
      };
    }

    const choice = await elicitSelection(
      "No date range provided. This query can return many results. Choose a window:",
      "range",
      [
        { value: "24h", label: "Last 24 hours" },
        { value: "7d", label: "Last 7 days" },
        { value: "30d", label: "Last 30 days" },
        { value: "custom", label: "Enter custom ISO 8601 dates" },
        { value: "all", label: "No filter (return everything)" },
      ]
    );

    const nowMs = Date.now();
    const PRESET_WINDOWS_MS: Record<string, number> = {
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
    };
    if (!choice || choice === "all") return {};
    if (choice in PRESET_WINDOWS_MS) {
      return { sinceMs: nowMs - PRESET_WINDOWS_MS[choice] };
    }
    if (choice === "custom") {
      const since = await elicitText(
        "Enter the start datetime in ISO 8601 format (e.g. 2025-04-01T00:00:00Z).",
        "since",
        "Start datetime"
      );
      const until = await elicitText(
        "Enter the end datetime in ISO 8601 format (leave blank for now).",
        "until",
        "End datetime"
      );
      return {
        sinceMs: since ? new Date(since).getTime() : undefined,
        untilMs: until ? new Date(until).getTime() : undefined,
      };
    }
    return {};
  }

  async function resolveClientId(
    client: DattoSaasProtectionClient,
    provided?: string
  ): Promise<string | null> {
    if (provided) return provided;

    try {
      const result = await client.clients.list({ limit: 50 });
      const items: Array<{ id: string; name?: string }> = Array.isArray(
        (result as { items?: unknown }).items
      )
        ? ((result as { items: Array<{ id: string; name?: string }> }).items)
        : (Array.isArray(result) ? (result as Array<{ id: string; name?: string }>) : []);

      if (items.length === 0) return null;

      const options = items.slice(0, 25).map((c) => ({
        value: c.id,
        label: c.name ? `${c.name} (${c.id})` : c.id,
      }));
      const picked = await elicitSelection(
        "Select a client:",
        "clientId",
        options
      );
      return picked;
    } catch {
      return null;
    }
  }

  async function resolveIncludeArchived(provided?: boolean): Promise<boolean> {
    if (provided !== undefined) return provided;

    const choice = await elicitSelection(
      "Include archived (deactivated) seats?",
      "includeArchived",
      [
        { value: "false", label: "No — only active seats" },
        { value: "true", label: "Yes — include archived" },
      ]
    );
    return choice === "true";
  }

  // -------------------------------------------------------------------------
  // Tool call handler
  // -------------------------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const creds = credentialOverrides ?? getCredentials();

    if (!creds) {
      return {
        content: [
          {
            type: "text",
            text:
              "Error: No API credentials provided. Please configure DATTO_SAAS_API_KEY (and optionally DATTO_SAAS_REGION) environment variables, or pass them as gateway headers.",
          },
        ],
        isError: true,
      };
    }

    const client = createClient(creds);

    try {
      switch (name) {
        case "datto_saas_list_clients": {
          const params = (args ?? {}) as { limit?: number };
          const result = await client.clients.list({ limit: params.limit ?? 100 });
          return { content: [{ type: "text", text: JSON.stringify(result ?? [], null, 2) }] };
        }

        case "datto_saas_list_domains": {
          const params = (args ?? {}) as { clientId?: string };
          const clientId = await resolveClientId(client, params.clientId);
          if (!clientId) {
            return {
              content: [{ type: "text", text: "Error: clientId is required." }],
              isError: true,
            };
          }
          const domains = await client.domains.list(clientId);
          return { content: [{ type: "text", text: JSON.stringify(domains ?? [], null, 2) }] };
        }

        case "datto_saas_list_seats": {
          const params = (args ?? {}) as {
            clientId: string;
            domainId: string;
            includeArchived?: boolean;
          };
          const includeArchived = await resolveIncludeArchived(params.includeArchived);
          const seats = await client.seats.list(params.clientId, params.domainId, {
            includeArchived,
          });
          return { content: [{ type: "text", text: JSON.stringify(seats ?? [], null, 2) }] };
        }

        case "datto_saas_get_seat": {
          const { seatId } = args as { seatId: string };
          const seat = await client.seats.get(seatId);
          return { content: [{ type: "text", text: JSON.stringify(seat ?? {}, null, 2) }] };
        }

        case "datto_saas_list_backups": {
          const { seatId } = args as { seatId: string };
          const backups = await client.backups.list(seatId);
          return { content: [{ type: "text", text: JSON.stringify(backups ?? [], null, 2) }] };
        }

        case "datto_saas_queue_restore": {
          const { seatId, items } = args as { seatId: string; items: string[] };
          const confirmed = await elicitConfirmation(
            `About to QUEUE A RESTORE for seat ${seatId} (${items.length} item(s)).\n\n` +
              "This writes data back into the target M365/GWS tenant. " +
              "The destination user must have appropriate Microsoft Graph / Google API permissions " +
              "for the restore to land successfully.\n\nProceed?"
          );
          if (confirmed !== true) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    confirmed === null
                      ? "Restore cancelled: client does not support confirmation prompts. Pass an explicit confirm flag from a different client to proceed."
                      : "Restore cancelled by user.",
                },
              ],
              isError: true,
            };
          }
          const restore = await client.restores.queue(seatId, { items });
          return { content: [{ type: "text", text: JSON.stringify(restore ?? {}, null, 2) }] };
        }

        case "datto_saas_get_restore_status": {
          const { restoreId } = args as { restoreId: string };
          const status = await client.restores.get(restoreId);
          return { content: [{ type: "text", text: JSON.stringify(status ?? {}, null, 2) }] };
        }

        case "datto_saas_list_activity": {
          const params = (args ?? {}) as { clientId: string; since?: string; until?: string };
          const range = await resolveDateRange(params);
          const activity = await client.activity.list(params.clientId);
          const list: Array<{ createdAt?: number | string; timestamp?: number | string }> =
            Array.isArray((activity as { items?: unknown }).items)
              ? ((activity as { items: Array<{ createdAt?: number | string; timestamp?: number | string }> }).items)
              : (Array.isArray(activity)
                  ? (activity as Array<{ createdAt?: number | string; timestamp?: number | string }>)
                  : []);
          const filtered = filterByDate(list, range);
          return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
        }

        case "datto_saas_get_license_usage": {
          const { clientId } = args as { clientId: string };
          const license = await client.license.getUsage(clientId);
          return { content: [{ type: "text", text: JSON.stringify(license ?? {}, null, 2) }] };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Transport: stdio (default)
// ---------------------------------------------------------------------------

async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Datto SaaS Protection MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// Transport: HTTP (StreamableHTTPServerTransport)
// ---------------------------------------------------------------------------

let httpServer: HttpServer | undefined;

async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const authMode = process.env.AUTH_MODE || "env";
  const isGatewayMode = authMode === "gateway";

  httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint - no auth required
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          transport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
          })
        );
        return;
      }

      // In gateway mode, extract credentials from headers and pass directly
      // to avoid process.env race conditions under concurrent load.
      let gatewayCredentials: DattoSaasCredentials | undefined;
      if (isGatewayMode) {
        const headers = req.headers as Record<string, string | string[] | undefined>;
        const apiKey = headers["x-datto-saas-api-key"] as string | undefined;
        const region = (headers["x-datto-saas-region"] as string | undefined) || "us";

        if (!apiKey) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing credentials",
              message:
                "Gateway mode requires the X-Datto-SaaS-API-Key header (X-Datto-SaaS-Region optional, defaults to 'us')",
              required: ["X-Datto-SaaS-API-Key"],
            })
          );
          return;
        }

        gatewayCredentials = { apiKey, region };
      }

      // Stateless: fresh server + transport per request
      const server = createMcpServer(gatewayCredentials);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      server
        .connect(transport as unknown as Transport)
        .then(() => {
          transport.handleRequest(req, res);
        })
        .catch((err) => {
          console.error("MCP transport error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal error" },
                id: null,
              })
            );
          }
        });

      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  await new Promise<void>((resolve) => {
    httpServer!.listen(port, host, () => {
      console.error(`Datto SaaS Protection MCP server listening on http://${host}:${port}/mcp`);
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers(): void {
  const shutdown = async () => {
    console.error("Shutting down Datto SaaS Protection MCP server...");
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  setupShutdownHandlers();

  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

main().catch(console.error);
