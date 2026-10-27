import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ensureEngine } from "./engine.js";
import { config } from "./config.js";

/**
 * MCP server for Claude's stdio connection that forwards everything to the shared
 * engine. Claude Desktop may start several stdio instances and route the model's
 * and the app's tool calls to different ones; forwarding keeps them all on one RFQ state.
 */
export function createProxyServer(): Server {
  const server = new Server({ name: "fx-rfq", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  let upstream: Promise<Client> | undefined;

  const connect = async () => {
    await ensureEngine();
    const client = new Client({ name: "fx-rfq-proxy", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${config.engineUrl}/mcp`)));
    return client;
  };

  async function forward<T>(call: (client: Client) => Promise<T>): Promise<T> {
    upstream ??= connect();
    try {
      return await call(await upstream);
    } catch (e) {
      if (e instanceof McpError) throw e;
      // The engine went away (e.g. Claude restarted the instance hosting it): start or find a new one.
      upstream = connect();
      return call(await upstream);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, (req) => forward((c) => c.listTools(req.params)));
  server.setRequestHandler(CallToolRequestSchema, (req) => forward((c) => c.callTool(req.params)));
  server.setRequestHandler(ListResourcesRequestSchema, (req) => forward((c) => c.listResources(req.params)));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) => forward((c) => c.listResourceTemplates(req.params)));
  server.setRequestHandler(ReadResourceRequestSchema, (req) => forward((c) => c.readResource(req.params)));
  return server;
}
