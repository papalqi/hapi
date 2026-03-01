import { describe, expect, it, vi } from 'vitest';
import { CodexSdkClient } from '../codexSdkClient';

type SdkEvent = {
    type: string;
    [key: string]: unknown;
};

async function* createEventStream(events: SdkEvent[]): AsyncGenerator<SdkEvent> {
    for (const event of events) {
        yield event;
    }
}

describe('CodexSdkClient', () => {
    it('maps mcp_tool_call/web_search/todo_list events to codex remote events', async () => {
        const client = new CodexSdkClient();
        const emitted: Array<Record<string, unknown>> = [];
        client.setHandler((event) => emitted.push(event));

        const thread = {
            id: 'thread-1',
            runStreamed: vi.fn(async () => ({
                events: createEventStream([
                    { type: 'turn.started' },
                    {
                        type: 'item.started',
                        item: { id: 'mcp-1', type: 'mcp_tool_call', server: 'filesystem', tool: 'read_file' }
                    },
                    {
                        type: 'item.completed',
                        item: {
                            id: 'mcp-1',
                            type: 'mcp_tool_call',
                            status: 'completed',
                            result: { structured_content: { ok: true } }
                        }
                    },
                    {
                        type: 'item.started',
                        item: { id: 'web-1', type: 'web_search', query: 'hapi codex sdk' }
                    },
                    {
                        type: 'item.completed',
                        item: { id: 'web-1', type: 'web_search', query: 'hapi codex sdk' }
                    },
                    {
                        type: 'item.updated',
                        item: {
                            id: 'todo-1',
                            type: 'todo_list',
                            items: [{ text: 'add tests', status: 'in_progress' }]
                        }
                    },
                    {
                        type: 'turn.completed',
                        usage: { input_tokens: 10, output_tokens: 20 }
                    }
                ])
            }))
        };

        (client as any).thread = thread;
        await client.startTurn({
            turnId: 'turn-1',
            input: [{ type: 'text', text: 'hello' }]
        });
        await (client as any).activeTurnPromise;

        expect(emitted.map((event) => event.type)).toEqual([
            'task_started',
            'exec_command_begin',
            'exec_command_end',
            'exec_command_begin',
            'exec_command_end',
            'todo_list',
            'token_count',
            'task_complete'
        ]);

        const mcpEnd = emitted.find((event) => event.type === 'exec_command_end' && event.call_id === 'mcp-1');
        expect(mcpEnd).toMatchObject({
            type: 'exec_command_end',
            command: 'mcp:filesystem/read_file',
            output: '{"ok":true}',
            status: 'completed'
        });

        const webEnd = emitted.find((event) => event.type === 'exec_command_end' && event.call_id === 'web-1');
        expect(webEnd).toMatchObject({
            type: 'exec_command_end',
            command: 'web_search hapi codex sdk',
            output: 'Searched web: hapi codex sdk',
            status: 'completed'
        });

        const todo = emitted.find((event) => event.type === 'todo_list');
        expect(todo).toEqual({
            type: 'todo_list',
            items: [{ text: 'add tests', status: 'in_progress' }]
        });
    });

    it('maps turn.cancelled to turn_aborted', async () => {
        const client = new CodexSdkClient();
        const emitted: Array<Record<string, unknown>> = [];
        client.setHandler((event) => emitted.push(event));

        const thread = {
            id: 'thread-2',
            runStreamed: vi.fn(async () => ({
                events: createEventStream([
                    { type: 'turn.started' },
                    { type: 'turn.cancelled' }
                ])
            }))
        };

        (client as any).thread = thread;
        await client.startTurn({
            turnId: 'turn-cancelled',
            input: [{ type: 'text', text: 'cancel me' }]
        });
        await (client as any).activeTurnPromise;

        expect(emitted).toEqual([
            { type: 'task_started', turn_id: 'turn-cancelled' },
            { type: 'turn_aborted', turn_id: 'turn-cancelled' }
        ]);
    });

    it('emits turn_aborted when interruptTurn aborts current stream', async () => {
        const client = new CodexSdkClient();
        const emitted: Array<Record<string, unknown>> = [];
        client.setHandler((event) => emitted.push(event));

        const thread = {
            id: 'thread-3',
            runStreamed: vi.fn(async (_input: unknown, turnOptions?: { signal?: AbortSignal }) => ({
                events: (async function* abortableStream() {
                    await new Promise<void>((resolve) => {
                        if (turnOptions?.signal?.aborted) {
                            resolve();
                            return;
                        }
                        turnOptions?.signal?.addEventListener('abort', () => resolve(), { once: true });
                    });

                    const abortError = new Error('aborted');
                    abortError.name = 'AbortError';
                    throw abortError;
                })()
            }))
        };

        (client as any).thread = thread;
        await client.startTurn({
            turnId: 'turn-abort',
            input: [{ type: 'text', text: 'abort me' }]
        });

        await client.interruptTurn();
        await (client as any).activeTurnPromise;

        expect(emitted).toContainEqual({ type: 'turn_aborted', turn_id: 'turn-abort' });
    });

    it('maps stream.error and error with additional details', async () => {
        const client = new CodexSdkClient();
        const emitted: Array<Record<string, unknown>> = [];
        client.setHandler((event) => emitted.push(event));

        const thread = {
            id: 'thread-4',
            runStreamed: vi.fn(async () => ({
                events: createEventStream([
                    { type: 'turn.started' },
                    {
                        type: 'stream.error',
                        message: 'stream decode failed',
                        additional_details: { phase: 'decode' }
                    },
                    {
                        type: 'error',
                        error: {
                            message: 'fatal sdk error',
                            additionalDetails: { traceId: 'trace-123' }
                        }
                    },
                    { type: 'turn.failed', message: 'failed after errors' }
                ])
            }))
        };

        (client as any).thread = thread;
        await client.startTurn({
            turnId: 'turn-errors',
            input: [{ type: 'text', text: 'trigger errors' }]
        });
        await (client as any).activeTurnPromise;

        expect(emitted).toContainEqual({
            type: 'stream_error',
            message: 'stream decode failed',
            additional_details: { phase: 'decode' }
        });

        expect(emitted).toContainEqual({
            type: 'error',
            message: 'fatal sdk error',
            additional_details: { traceId: 'trace-123' }
        });

        expect(emitted).toContainEqual({
            type: 'task_failed',
            turn_id: 'turn-errors',
            error: 'failed after errors'
        });
    });

    it('maps reasoning section breaks and approval request events', async () => {
        const client = new CodexSdkClient();
        const emitted: Array<Record<string, unknown>> = [];
        client.setHandler((event) => emitted.push(event));

        const thread = {
            id: 'thread-5',
            runStreamed: vi.fn(async () => ({
                events: createEventStream([
                    { type: 'turn.started' },
                    { type: 'item.started', item: { id: 'reason-1', type: 'reasoning', text: '' } },
                    { type: 'item.updated', item: { id: 'reason-1', type: 'reasoning', text: 'first section' } },
                    { type: 'item.started', item: { id: 'reason-2', type: 'reasoning', text: '' } },
                    { type: 'item.updated', item: { id: 'reason-2', type: 'reasoning', text: 'second section' } },
                    {
                        type: 'item.started',
                        item: {
                            id: 'approve-1',
                            type: 'exec_approval_request',
                            command: 'rm -rf /tmp/test',
                            cwd: '/tmp',
                            message: 'Need approval'
                        }
                    },
                    { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }
                ])
            }))
        };

        (client as any).thread = thread;
        await client.startTurn({
            turnId: 'turn-reasoning',
            input: [{ type: 'text', text: 'reason and ask approval' }]
        });
        await (client as any).activeTurnPromise;

        const sectionBreaks = emitted.filter((event) => event.type === 'agent_reasoning_section_break');
        expect(sectionBreaks.length).toBe(1);

        expect(emitted).toContainEqual({
            type: 'exec_approval_request',
            call_id: 'approve-1',
            command: 'rm -rf /tmp/test',
            cwd: '/tmp',
            message: 'Need approval'
        });
    });
});
