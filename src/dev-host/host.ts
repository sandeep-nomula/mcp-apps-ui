// A minimal MCP Apps host for local testing. It plays Claude's part: calls the
// tool over MCP, fetches the ui:// resource, renders it in a sandboxed iframe
// with the declared CSP, and bridges postMessage <-> MCP via AppBridge.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AppBridge, PostMessageTransport, getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiHostContext, McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";

const chat = document.getElementById("chat")!;
const conn = document.getElementById("conn")!;
const form = document.getElementById("composer") as HTMLFormElement;
const bridges = new Set<AppBridge>();

let theme: "light" | "dark" = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.dataset.theme = theme;
const hostContext = (): McpUiHostContext => ({ theme, platform: "web", displayMode: "inline", availableDisplayModes: ["inline"] });

function bubble(kind: "user" | "assistant" | "system", ...children: (Node | string)[]) {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.append(...children);
  chat.append(el);
  el.scrollIntoView({ behavior: "smooth", block: "end" });
  return el;
}

const client = new Client({ name: "fx-rfq-dev-host", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.origin)));
const { tools } = await client.listTools();
conn.textContent = `connected · ${tools.length} tools`;

function cspMeta(csp: McpUiResourceCsp | undefined) {
  const connect = ["'self'", ...(csp?.connectDomains ?? [])].join(" ");
  const res = ["'self'", "data:", "blob:", ...(csp?.resourceDomains ?? [])].join(" ");
  return (
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${res}; ` +
    `style-src 'unsafe-inline' ${res}; img-src ${res}; font-src ${res}; connect-src ${connect}; frame-src 'none'">`
  );
}

async function runTool(name: string, args: Record<string, unknown>) {
  const tool = tools.find((t) => t.name === name) as Tool;
  const uri = getToolUiResourceUri(tool);
  const wrap = bubble("assistant");
  const label = document.createElement("div");
  label.className = "tool";
  label.textContent = `⚙ ${name}(${JSON.stringify(args)})`;
  wrap.append(label);

  if (!uri) {
    const result = await client.callTool({ name, arguments: args });
    wrap.append(JSON.stringify(result.content));
    return;
  }

  // Fetch the UI resource and render it the way a host does.
  const res = await client.readResource({ uri });
  const content = res.contents[0] as { text: string; _meta?: { ui?: { csp?: McpUiResourceCsp } } };
  const html = content.text.replace(/<head>/i, `<head>${cspMeta(content._meta?.ui?.csp)}`);
  const iframe = document.createElement("iframe");
  // Claude serves app iframes from their own sandbox origin. A plain opaque-origin
  // sandbox counts as "public" to Chrome's Local Network Access rules, which blocks
  // ws://localhost, so allow-same-origin stands in for that dedicated origin here.
  iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
  iframe.srcdoc = html;
  wrap.append(iframe);

  const bridge = new AppBridge(
    client,
    { name: "fx-rfq-dev-host", version: "1.0.0" },
    { serverTools: {}, logging: {}, openLinks: {}, updateModelContext: { text: {} }, message: { text: {} } },
    { hostContext: hostContext() },
  );
  const initialTheme = theme;
  bridge.onsizechange = ({ height }) => {
    if (height) iframe.style.height = `${Math.ceil(height) + 2}px`; // + iframe border
  };
  bridge.onupdatemodelcontext = async ({ content }) => {
    const text = content?.map((c) => ("text" in c ? c.text : "")).join(" ");
    bubble("system", `Model context updated: ${text}`);
    return {};
  };
  bridge.onmessage = async ({ content }) => {
    bubble("user", content.map((c) => ("text" in c ? c.text : "")).join(" "));
    bubble("assistant", "(Claude would reply here.)");
    return {};
  };
  bridge.onopenlink = async ({ url }) => {
    window.open(url, "_blank", "noopener");
    return {};
  };

  const ready = new Promise<void>((resolve) => (bridge.oninitialized = () => resolve()));
  await new Promise((r) => iframe.addEventListener("load", r, { once: true }));
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  await ready;
  bridges.add(bridge);
  // The theme may have been toggled while the view was starting up.
  if (theme !== initialTheme) await bridge.sendHostContextChange({ theme });

  await bridge.sendToolInput({ arguments: args });
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  await bridge.sendToolResult(result);
  const text = result.content.find((c) => c.type === "text");
  if (text && "text" in text) label.title = text.text;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(form);
  const args: Record<string, unknown> = {
    pair: String(f.get("pair")).toUpperCase(),
    side: f.get("side"),
    amount: Number(f.get("amount")),
    banks: f.getAll("bank"),
  };
  const dealt = String(f.get("dealt") ?? "").trim().toUpperCase();
  if (dealt) args.dealtCurrency = dealt;
  bubble("user", `Get me prices to ${String(args.side).toLowerCase()} ${Number(args.amount).toLocaleString()} ${dealt || String(args.pair).slice(0, 3)} ${args.pair} from ${(args.banks as string[]).join(", ")}`);
  runTool("request_fx_quotes", args).catch((err) => bubble("system", `Error: ${err.message}`));
});

document.getElementById("trades")!.addEventListener("click", () => {
  bubble("user", "Show my accepted trades");
  runTool("list_trades", {}).catch((err) => bubble("system", `Error: ${err.message}`));
});

document.getElementById("theme")!.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  bridges.forEach((b) => b.sendHostContextChange({ theme }));
});
