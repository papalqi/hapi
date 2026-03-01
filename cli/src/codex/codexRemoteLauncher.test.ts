import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = vi.hoisted(() => ({
    notifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    sdkTurnEvents: [] as Array<Record<string, unknown>>,
    sdkThreadId: 'thread-sdk-e2e'
}));

vi.mock('./codexAppServerClient', () => {
    class MockCodexAppServerClient {
        private notificationHandler: ((method: string, params: unknown) => void) | null = null;

        async connect(): Promise<void> {}

        async initialize(): Promise<{ protocolVersion: number }> {
            return { protocolVersion: 1 };
        }

        setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
            this.notificationHandler = handler;
        }

        registerRequestHandler(method: string): void {
            harness.registerRequestCalls.push(method);
        }

        async startThread(): Promise<{ thread: { id: string } }> {
            return { thread: { id: 'thread-anonymous' } };
        }

        async resumeThread(): Promise<{ thread: { id: string } }> {
            return { thread: { id: 'thread-anonymous' } };
        }

        async startTurn(): Promise<{ turn: Record<string, never> }> {
            const started = { turn: {} };
            harness.notifications.push({ method: 'turn/started', params: started });
            this.notificationHandler?.('turn/started', started);

            const completed = { status: 'Completed', turn: {} };
            harness.notifications.push({ method: 'turn/completed', params: completed });
            this.notificationHandler?.('turn/completed', completed);

            return { turn: {} };
        }

        async interruptTurn(): Promise<Record<string, never>> {
            return {};
        }

        async disconnect(): Promise<void> {}
    }

    return { CodexAppServerClient: MockCodexAppServerClient };
});

vi.mock('./codexSdkClient', () => {
    class MockCodexSdkClient {
        private handler: ((event: Record<string, unknown>) => void) | null = null;

        setHandler(handler: ((event: Record<string, unknown>) => void) | null): void {
            this.handler = handler;
        }

        async connect(): Promise<void> {}

        async disconnect(): Promise<void> {}

        clearThread(): void {}

        async startThread(): Promise<{ thread: { id: string } }> {
            return {
                thread: { id: harness.sdkThreadId }
            };
        }

        async resumeThread(): Promise<{ thread: { id: string } }> {
            return {
                thread: { id: harness.sdkThreadId }
            };
        }

        async startTurn(): Promise<{ turn: { id: string; status: 'started' } }> {
            const events = harness.sdkTurnEvents.length > 0
                ? harness.sdkTurnEvents
                : [
                    { type: 'task_started', turn_id: 'turn-sdk-default' },
                    { type: 'task_complete', turn_id: 'turn-sdk-default' }
                ];
            for (const event of events) {
                this.handler?.(event);
            }
            return {
                turn: {
                    id: 'turn-sdk-default',
                    status: 'started'
                }
            };
        }

        async interruptTurn(): Promise<{ ok: boolean }> {
            return { ok: true };
        }
    }

    return { CodexSdkClient: MockCodexSdkClient };
});

vi.mock('./utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: {
            stop: () => {}
        },
        mcpServers: {}
    })
}));

import { codexRemoteLauncher } from './codexRemoteLauncher';

type FakeAgentState = {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
};

function createMode(): EnhancedMode {
    return {
        permissionMode: 'default'
    };
}

function createSessionStub() {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
    queue.push('hello from launcher test', createMode());
    queue.close();

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const codexMessages: unknown[] = [];
    const thinkingChanges: boolean[] = [];
    const foundSessionIds: string[] = [];
    let agentState: FakeAgentState = {
        requests: {},
        completedRequests: {}
    };

    const rpcHandlers = new Map<string, (params: unknown) => unknown>();
    const client = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        updateAgentState(handler: (state: FakeAgentState) => FakeAgentState) {
            agentState = handler(agentState);
        },
        sendCodexMessage(message: unknown) {
            codexMessages.push(message);
        },
        sendUserMessage(_text: string) {},
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            sessionEvents.push(event);
        }
    };

    const session = {
        path: '/tmp/hapi-update',
        logPath: '/tmp/hapi-update/test.log',
        client,
        queue,
        codexArgs: undefined,
        codexCliOverrides: undefined,
        sessionId: null as string | null,
        thinking: false,
        onThinkingChange(nextThinking: boolean) {
            session.thinking = nextThinking;
            thinkingChanges.push(nextThinking);
        },
        onSessionFound(id: string) {
            session.sessionId = id;
            foundSessionIds.push(id);
        },
        sendCodexMessage(message: unknown) {
            client.sendCodexMessage(message);
        },
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            client.sendSessionEvent(event);
        },
        sendUserMessage(text: string) {
            client.sendUserMessage(text);
        }
    };

    return {
        session,
        sessionEvents,
        codexMessages,
        thinkingChanges,
        foundSessionIds,
        rpcHandlers,
        getAgentState: () => agentState
    };
}

describe('codexRemoteLauncher', () => {
    afterEach(() => {
        harness.notifications = [];
        harness.registerRequestCalls = [];
        harness.sdkTurnEvents = [];
        harness.sdkThreadId = 'thread-sdk-e2e';
        delete process.env.CODEX_USE_MCP_SERVER;
        delete process.env.CODEX_USE_SDK;
    });

    it('finishes a turn and emits ready when task lifecycle events omit turn_id', async () => {
        delete process.env.CODEX_USE_MCP_SERVER;
        const {
            session,
            sessionEvents,
            thinkingChanges,
            foundSessionIds
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(foundSessionIds).toContain('thread-anonymous');
        expect(harness.notifications.map((entry) => entry.method)).toEqual(['turn/started', 'turn/completed']);
        expect(harness.registerRequestCalls).toEqual([
            'item/commandExecution/requestApproval',
            'item/fileChange/requestApproval',
            'item/tool/requestUserInput'
        ]);
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);
    });

    it('sdk e2e: propagates section break, token_count, plan, approval request, and ready lifecycle', async () => {
        process.env.CODEX_USE_SDK = '1';
        harness.sdkThreadId = 'thread-sdk-42';
        harness.sdkTurnEvents = [
            { type: 'task_started', turn_id: 'turn-sdk-42' },
            { type: 'agent_reasoning_delta', delta: '**Plan' },
            { type: 'agent_reasoning_delta', delta: '** draft plan' },
            { type: 'agent_reasoning_section_break' },
            { type: 'agent_reasoning_delta', delta: '**Execute** run checks' },
            { type: 'agent_reasoning', text: '**Execute** run checks' },
            { type: 'token_count', info: { input_tokens: 12, output_tokens: 34 } },
            {
                type: 'todo_list',
                items: [{ text: 'verify e2e', status: 'in_progress', priority: 'high' }]
            },
            {
                type: 'exec_approval_request',
                call_id: 'approve-42',
                command: 'rm -rf /tmp/safe',
                cwd: '/tmp'
            },
            { type: 'task_complete', turn_id: 'turn-sdk-42' }
        ];

        const {
            session,
            sessionEvents,
            codexMessages,
            thinkingChanges,
            foundSessionIds
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(foundSessionIds).toContain('thread-sdk-42');
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);

        const messages = codexMessages as Array<Record<string, unknown>>;

        expect(messages.some((message) => message.type === 'token_count')).toBe(true);
        expect(messages).toContainEqual({
            type: 'plan',
            entries: [{ content: 'verify e2e', priority: 'high', status: 'in_progress' }]
        });
        expect(messages).toContainEqual({
            type: 'tool-call',
            name: 'CodexBash',
            callId: 'approve-42',
            input: {
                command: 'rm -rf /tmp/safe',
                cwd: '/tmp'
            },
            id: expect.any(String)
        });

        const reasoningToolStarts = messages.filter(
            (message) => message.type === 'tool-call' && message.name === 'CodexReasoning'
        );
        const reasoningToolResults = messages.filter(
            (message) =>
                message.type === 'tool-call-result'
                && message.output
                && typeof message.output === 'object'
                && 'status' in (message.output as Record<string, unknown>)
        );

        expect(reasoningToolStarts.length).toBeGreaterThanOrEqual(1);
        expect(reasoningToolResults.some(
            (message) => (message.output as Record<string, unknown>).status === 'canceled'
        )).toBe(true);
        expect(reasoningToolResults.some(
            (message) => (message.output as Record<string, unknown>).status === 'completed'
        )).toBe(true);
    });
});
