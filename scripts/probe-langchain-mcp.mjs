import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function list(name, url) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'langcanvas-probe', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log('\n===', name, '===');
  for (const t of tools.tools || []) {
    console.log('-', t.name, ':', (t.description || '').slice(0, 120));
    console.log('  schema keys:', Object.keys(t.inputSchema?.properties || {}));
  }
  await client.close().catch(() => {});
}

await list('docs', 'https://docs.langchain.com/mcp');
await list('reference', 'https://reference.langchain.com/mcp');
