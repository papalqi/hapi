import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHappyServer } from './startHappyServer';

describe('startHappyServer', () => {
    it('serves change_title via streamable HTTP', async () => {
        const sentSummaries: unknown[] = [];
        const fakeClient = {
            sendClaudeSessionMessage: (message: unknown) => {
                sentSummaries.push(message);
            }
        } as any;

        const server = await startHappyServer(fakeClient);
        const transport = new StreamableHTTPClientTransport(new URL(server.url));
        const client = new Client(
            { name: 'start-happy-server-test', version: '1.0.0' },
            { capabilities: {} }
        );

        try {
            await client.connect(transport);

            const firstResult = await client.callTool({ name: 'change_title', arguments: { title: 'title-1' } });
            const secondResult = await client.callTool({ name: 'change_title', arguments: { title: 'title-2' } });

            expect(firstResult).toMatchObject({ isError: false });
            expect(secondResult).toMatchObject({ isError: false });
            expect(sentSummaries).toHaveLength(2);
            expect(sentSummaries[0]).toMatchObject({ type: 'summary', summary: 'title-1' });
            expect(sentSummaries[1]).toMatchObject({ type: 'summary', summary: 'title-2' });
        } finally {
            await transport.close();
            server.stop();
        }
    });
});

