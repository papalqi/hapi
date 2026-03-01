import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

type SdkThreadEvent = {
    type: string;
    [key: string]: unknown;
};

type CodexSdkOptions = {
    codexPathOverride?: string;
    baseUrl?: string;
    apiKey?: string;
    config?: Record<string, unknown>;
    env?: Record<string, string>;
};

type CodexSdkThreadOptions = {
    model?: string;
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
    workingDirectory?: string;
    skipGitRepoCheck?: boolean;
    modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    networkAccessEnabled?: boolean;
    approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
    additionalDirectories?: string[];
    webSearchMode?: 'disabled' | 'cached' | 'live';
};

type CodexSdkThread = {
    id: string | null;
    runStreamed: (
        input: string | Array<{ type: 'text'; text: string }>,
        turnOptions?: { signal?: AbortSignal }
    ) => Promise<{ events: AsyncGenerator<SdkThreadEvent> }>;
};

type CodexSdkInstance = {
    startThread: (options?: CodexSdkThreadOptions) => CodexSdkThread;
    resumeThread: (id: string, options?: CodexSdkThreadOptions) => CodexSdkThread;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') return null;
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeItemType(value: unknown): string | null {
    const raw = asString(value);
    if (!raw) return null;
    return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null || value === undefined) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function resolveTextInput(input: unknown): string {
    if (typeof input === 'string') return input;
    if (Array.isArray(input)) {
        const parts = input
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== null)
            .filter((entry) => entry.type === 'text')
            .map((entry) => asString(entry.text))
            .filter((text): text is string => text !== null);
        return parts.join('\n');
    }
    return '';
}

function extractTextFromContent(value: unknown): string | null {
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }

    if (!Array.isArray(value)) {
        return null;
    }

    const parts = value
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => asString(entry.text ?? entry.value))
        .filter((text): text is string => text !== null && text.length > 0);

    if (parts.length === 0) {
        return null;
    }

    return parts.join('\n');
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (a[key] !== b[key]) return false;
    }
    return true;
}

export class CodexSdkClient {
    private sdk: CodexSdkInstance | null = null;
    private thread: CodexSdkThread | null = null;
    private notificationHandler: ((event: Record<string, unknown>) => void) | null = null;
    private turnAbortController: AbortController | null = null;
    private activeTurnPromise: Promise<void> | null = null;
    private readonly reasoningBuffers = new Map<string, string>();
    private readonly commandOutputBuffers = new Map<string, string>();
    private readonly toolCallCommandLabels = new Map<string, string>();
    private sdkCtorOptions: CodexSdkOptions = {};

    setHandler(handler: ((event: Record<string, unknown>) => void) | null): void {
        this.notificationHandler = handler;
    }

    async connect(options?: { sdkOptions?: CodexSdkOptions }): Promise<void> {
        if (options?.sdkOptions) {
            this.sdkCtorOptions = options.sdkOptions;
        }

        if (this.sdk) {
            return;
        }

        let imported: unknown;
        try {
            // Keep the specifier literal so Bun compile can bundle the SDK into the executable.
            imported = await import('@openai/codex-sdk');
        } catch (error) {
            const reason = error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
            throw new Error(`Failed to load @openai/codex-sdk: ${reason}`, { cause: error });
        }

        const importedRecord = asRecord(imported);
        const importedDefault = asRecord(importedRecord?.default);
        const codexCtor =
            importedRecord?.Codex
            ?? importedDefault?.Codex
            ?? importedRecord?.default;
        if (typeof codexCtor !== 'function') {
            throw new Error('@openai/codex-sdk does not export Codex');
        }

        this.sdk = new (codexCtor as new (options?: CodexSdkOptions) => CodexSdkInstance)(this.sdkCtorOptions);
        logger.debug('[CodexSdkClient] Connected');
    }

    async disconnect(): Promise<void> {
        this.turnAbortController?.abort();
        try {
            await this.activeTurnPromise;
        } catch {
            // ignore turn errors during shutdown
        }
        this.activeTurnPromise = null;
        this.turnAbortController = null;
        this.thread = null;
        this.sdk = null;
        this.reasoningBuffers.clear();
        this.commandOutputBuffers.clear();
        this.toolCallCommandLabels.clear();
        logger.debug('[CodexSdkClient] Disconnected');
    }

    clearThread(): void {
        this.thread = null;
        this.reasoningBuffers.clear();
        this.commandOutputBuffers.clear();
        this.toolCallCommandLabels.clear();
    }

    async startThread(args?: {
        sdkOptions?: CodexSdkOptions;
        threadOptions?: CodexSdkThreadOptions;
    }): Promise<{ thread: { id: string | null } }> {
        if (args?.sdkOptions) {
            const next = args.sdkOptions as Record<string, unknown>;
            const current = this.sdkCtorOptions as Record<string, unknown>;
            if (!shallowEqual(current, next)) {
                await this.disconnect();
                this.sdkCtorOptions = args.sdkOptions;
            }
        }
        await this.connect();
        if (!this.sdk) {
            throw new Error('Codex SDK not connected');
        }
        this.thread = this.sdk.startThread(args?.threadOptions);
        return { thread: { id: this.thread.id } };
    }

    async resumeThread(args: {
        threadId: string;
        sdkOptions?: CodexSdkOptions;
        threadOptions?: CodexSdkThreadOptions;
    }): Promise<{ thread: { id: string | null } }> {
        if (args.sdkOptions) {
            const next = args.sdkOptions as Record<string, unknown>;
            const current = this.sdkCtorOptions as Record<string, unknown>;
            if (!shallowEqual(current, next)) {
                await this.disconnect();
                this.sdkCtorOptions = args.sdkOptions;
            }
        }
        await this.connect();
        if (!this.sdk) {
            throw new Error('Codex SDK not connected');
        }
        this.thread = this.sdk.resumeThread(args.threadId, args.threadOptions);
        return { thread: { id: this.thread.id ?? args.threadId } };
    }

    async startTurn(args: {
        turnId?: string;
        input: unknown;
        signal?: AbortSignal;
    }): Promise<{ turn: { id: string; status: 'started' } }> {
        if (!this.thread) {
            throw new Error('No active SDK thread');
        }
        if (this.activeTurnPromise) {
            throw new Error('SDK turn already in progress');
        }

        const turnId = args.turnId ?? randomUUID();
        const inputText = resolveTextInput(args.input);
        const turnAbortController = new AbortController();
        this.turnAbortController = turnAbortController;

        if (args.signal) {
            if (args.signal.aborted) {
                turnAbortController.abort();
            } else {
                args.signal.addEventListener('abort', () => turnAbortController.abort(), { once: true });
            }
        }

        const stream = await this.thread.runStreamed(inputText, { signal: turnAbortController.signal });
        this.activeTurnPromise = this.consumeTurnEvents(turnId, stream.events)
            .catch((error) => {
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                if (isAbortError) {
                    this.emit({ type: 'turn_aborted', turn_id: turnId });
                    return;
                }
                logger.debug('[CodexSdkClient] Error while consuming SDK stream', error);
                this.emit({
                    type: 'error',
                    message: error instanceof Error ? error.message : String(error)
                });
            })
            .finally(() => {
                this.activeTurnPromise = null;
                this.turnAbortController = null;
            });

        return {
            turn: {
                id: turnId,
                status: 'started'
            }
        };
    }

    async interruptTurn(): Promise<{ ok: boolean }> {
        this.turnAbortController?.abort();
        return { ok: true };
    }

    private emit(event: Record<string, unknown>): void {
        this.notificationHandler?.(event);
    }

    private async consumeTurnEvents(turnId: string, events: AsyncGenerator<SdkThreadEvent>): Promise<void> {
        const reasoningItemIds = new Set<string>();

        for await (const event of events) {
            const eventRecord = asRecord(event);
            const eventType = asString(eventRecord?.type);
            if (!eventType) continue;

            if (eventType === 'thread.started') {
                const threadId = asString(eventRecord?.thread_id);
                if (threadId) {
                    this.emit({ type: 'thread_started', thread_id: threadId });
                }
                continue;
            }

            if (eventType === 'turn.started') {
                reasoningItemIds.clear();
                this.emit({ type: 'task_started', turn_id: turnId });
                continue;
            }

            if (eventType === 'turn.completed') {
                const usage = asRecord(eventRecord?.usage);
                if (usage) {
                    this.emit({ type: 'token_count', info: usage });
                }

                const status = asString(eventRecord?.status)?.toLowerCase();
                if (status === 'interrupted' || status === 'cancelled' || status === 'canceled' || status === 'aborted') {
                    this.emit({ type: 'turn_aborted', turn_id: turnId });
                    continue;
                }

                if (status === 'failed' || status === 'error') {
                    const errorMessage = asString(asRecord(eventRecord?.error)?.message) ?? asString(eventRecord?.message);
                    this.emit({
                        type: 'task_failed',
                        turn_id: turnId,
                        ...(errorMessage ? { error: errorMessage } : {})
                    });
                    continue;
                }

                this.emit({ type: 'task_complete', turn_id: turnId });
                continue;
            }

            if (
                eventType === 'turn.aborted'
                || eventType === 'turn.interrupted'
                || eventType === 'turn.cancelled'
                || eventType === 'turn.canceled'
            ) {
                this.emit({ type: 'turn_aborted', turn_id: turnId });
                continue;
            }

            if (eventType === 'turn.failed') {
                const errorMessage = asString(asRecord(eventRecord?.error)?.message) ?? asString(eventRecord?.message);
                this.emit({
                    type: 'task_failed',
                    turn_id: turnId,
                    ...(errorMessage ? { error: errorMessage } : {})
                });
                continue;
            }

            if (eventType === 'turn.error') {
                const errorMessage = asString(asRecord(eventRecord?.error)?.message) ?? asString(eventRecord?.message);
                this.emit({
                    type: 'task_failed',
                    turn_id: turnId,
                    ...(errorMessage ? { error: errorMessage } : {})
                });
                continue;
            }

            if (eventType === 'stream_error' || eventType === 'stream.error') {
                const errorRecord = asRecord(eventRecord?.error);
                const message = asString(eventRecord?.message) ?? asString(errorRecord?.message) ?? 'Unknown SDK stream error';
                const additionalDetails = eventRecord?.additional_details
                    ?? eventRecord?.additionalDetails
                    ?? errorRecord?.additional_details
                    ?? errorRecord?.additionalDetails;
                this.emit({
                    type: 'stream_error',
                    message,
                    ...(additionalDetails !== undefined ? { additional_details: additionalDetails } : {})
                });
                continue;
            }

            if (eventType === 'exec_approval_request' || eventType === 'exec.approval_request' || eventType === 'approval.requested') {
                const callId = asString(eventRecord?.call_id ?? eventRecord?.callId ?? eventRecord?.id) ?? randomUUID();
                this.emit({
                    type: 'exec_approval_request',
                    call_id: callId,
                    ...(asString(eventRecord?.command) ? { command: asString(eventRecord?.command) } : {}),
                    ...(asString(eventRecord?.cwd) ? { cwd: asString(eventRecord?.cwd) } : {}),
                    ...(asString(eventRecord?.message) ? { message: asString(eventRecord?.message) } : {}),
                    ...(asString(eventRecord?.tool) ? { tool: asString(eventRecord?.tool) } : {})
                });
                continue;
            }

            if (eventType === 'error') {
                const errorRecord = asRecord(eventRecord?.error);
                const message = asString(eventRecord?.message) ?? asString(errorRecord?.message) ?? 'Unknown SDK stream error';
                const additionalDetails = eventRecord?.additional_details
                    ?? eventRecord?.additionalDetails
                    ?? errorRecord?.additional_details
                    ?? errorRecord?.additionalDetails;
                this.emit({
                    type: 'error',
                    message,
                    ...(additionalDetails !== undefined ? { additional_details: additionalDetails } : {})
                });
                continue;
            }

            if (eventType === 'item.started' || eventType === 'item.updated' || eventType === 'item.completed') {
                const item = asRecord(eventRecord?.item);
                const itemType = normalizeItemType(item?.type);
                const itemId = asString(item?.id);
                if (!item || !itemType || !itemId) continue;

                if (itemType === 'agentmessage') {
                    if (eventType === 'item.completed') {
                        const text = asString(item.text) ?? extractTextFromContent(item.content);
                        if (text) {
                            this.emit({ type: 'agent_message', message: text });
                        }
                    }
                    continue;
                }

                if (itemType === 'reasoning') {
                    if (eventType === 'item.started') {
                        if (!reasoningItemIds.has(itemId) && reasoningItemIds.size > 0) {
                            this.emit({ type: 'agent_reasoning_section_break' });
                        }
                        reasoningItemIds.add(itemId);
                    } else if (eventType === 'item.updated' && !reasoningItemIds.has(itemId)) {
                        if (reasoningItemIds.size > 0) {
                            this.emit({ type: 'agent_reasoning_section_break' });
                        }
                        reasoningItemIds.add(itemId);
                    }

                    const text = asString(item.text) ?? extractTextFromContent(item.content) ?? '';
                    if (eventType === 'item.updated') {
                        const prev = this.reasoningBuffers.get(itemId) ?? '';
                        if (text.length > prev.length && text.startsWith(prev)) {
                            const delta = text.slice(prev.length);
                            if (delta.length > 0) {
                                this.emit({ type: 'agent_reasoning_delta', delta });
                            }
                        }
                        this.reasoningBuffers.set(itemId, text);
                    } else if (eventType === 'item.completed') {
                        const full = text || this.reasoningBuffers.get(itemId);
                        if (full) {
                            this.emit({ type: 'agent_reasoning', text: full });
                        }
                        this.reasoningBuffers.delete(itemId);
                    }
                    continue;
                }

                if (itemType === 'commandexecution') {
                    const command = asString(item.command);
                    const output = asString(item.aggregated_output) ?? '';
                    if (eventType === 'item.started') {
                        this.commandOutputBuffers.set(itemId, output);
                        this.emit({
                            type: 'exec_command_begin',
                            call_id: itemId,
                            ...(command ? { command } : {})
                        });
                    } else if (eventType === 'item.updated') {
                        this.commandOutputBuffers.set(itemId, output);
                    } else if (eventType === 'item.completed') {
                        const status = asString(item.status);
                        const exitCode = asNumber(item.exit_code);
                        const finalOutput = output || this.commandOutputBuffers.get(itemId) || '';
                        this.emit({
                            type: 'exec_command_end',
                            call_id: itemId,
                            ...(command ? { command } : {}),
                            ...(finalOutput ? { output: finalOutput } : {}),
                            ...(status ? { status } : {}),
                            ...(exitCode !== null ? { exit_code: exitCode } : {})
                        });
                        this.commandOutputBuffers.delete(itemId);
                    }
                    continue;
                }

                if (itemType === 'filechange') {
                    const changes = Array.isArray(item.changes) ? item.changes : [];
                    if (eventType === 'item.started') {
                        this.emit({
                            type: 'patch_apply_begin',
                            call_id: itemId,
                            changes
                        });
                    } else if (eventType === 'item.completed') {
                        const status = asString(item.status);
                        this.emit({
                            type: 'patch_apply_end',
                            call_id: itemId,
                            changes,
                            success: status !== 'failed'
                        });
                    }
                    continue;
                }

                if (itemType === 'execapprovalrequest' || itemType === 'approvalrequest') {
                    if (eventType === 'item.started' || eventType === 'item.updated' || eventType === 'item.completed') {
                        this.emit({
                            type: 'exec_approval_request',
                            call_id: itemId,
                            ...(asString(item.command) ? { command: asString(item.command) } : {}),
                            ...(asString(item.cwd) ? { cwd: asString(item.cwd) } : {}),
                            ...(asString(item.message) ? { message: asString(item.message) } : {}),
                            ...(asString(item.tool) ? { tool: asString(item.tool) } : {}),
                            ...(asString(item.status) ? { status: asString(item.status) } : {})
                        });
                    }
                    continue;
                }

                if (itemType === 'mcptoolcall') {
                    const server = asString(item.server) ?? 'mcp';
                    const tool = asString(item.tool) ?? 'tool';
                    const commandLabel = this.toolCallCommandLabels.get(itemId) ?? `mcp:${server}/${tool}`;
                    if (eventType === 'item.started') {
                        this.toolCallCommandLabels.set(itemId, commandLabel);
                        this.emit({
                            type: 'exec_command_begin',
                            call_id: itemId,
                            command: commandLabel
                        });
                    } else if (eventType === 'item.completed') {
                        const status = asString(item.status);
                        const result = asRecord(item.result);
                        const resultContent = result?.structured_content ?? result?.content;
                        const errorMessage = asString(asRecord(item.error)?.message);
                        const output = toText(resultContent);
                        this.emit({
                            type: 'exec_command_end',
                            call_id: itemId,
                            command: commandLabel,
                            ...(output ? { output } : {}),
                            ...(errorMessage ? { error: errorMessage } : {}),
                            ...(status ? { status } : {})
                        });
                        this.toolCallCommandLabels.delete(itemId);
                    }
                    continue;
                }

                if (itemType === 'websearch') {
                    const query = asString(item.query) ?? '';
                    const commandLabel = this.toolCallCommandLabels.get(itemId)
                        ?? (query ? `web_search ${query}` : 'web_search');
                    if (eventType === 'item.started') {
                        this.toolCallCommandLabels.set(itemId, commandLabel);
                        this.emit({
                            type: 'exec_command_begin',
                            call_id: itemId,
                            command: commandLabel
                        });
                    } else if (eventType === 'item.completed') {
                        this.emit({
                            type: 'exec_command_end',
                            call_id: itemId,
                            command: commandLabel,
                            output: query ? `Searched web: ${query}` : 'Web search completed',
                            status: 'completed'
                        });
                        this.toolCallCommandLabels.delete(itemId);
                    }
                    continue;
                }

                if (itemType === 'todolist') {
                    if (eventType === 'item.updated' || eventType === 'item.completed') {
                        const todos = Array.isArray(item.items)
                            ? item.items
                            : Array.isArray(item.todos)
                                ? item.todos
                                : [];
                        this.emit({
                            type: 'todo_list',
                            items: todos
                        });
                    }
                    continue;
                }

                if (itemType === 'error' && eventType === 'item.completed') {
                    const message = asString(item.message) ?? 'SDK item error';
                    this.emit({ type: 'error', message });
                    continue;
                }
            }
        }
    }
}
