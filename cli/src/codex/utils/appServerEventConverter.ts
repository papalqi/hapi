import { logger } from '@/ui/logger';

type ConvertedEvent = {
    type: string;
    [key: string]: unknown;
};

const DIRECT_EVENT_TYPE_ALIASES: Record<string, string> = {
    'task/started': 'task_started',
    task_started: 'task_started',
    'task/completed': 'task_complete',
    task_completed: 'task_complete',
    task_complete: 'task_complete',
    'turn/aborted': 'turn_aborted',
    turn_aborted: 'turn_aborted',
    'task/failed': 'task_failed',
    task_failed: 'task_failed',
    'stream/error': 'stream_error',
    stream_error: 'stream_error',
    error: 'error',
    'agent/message': 'agent_message',
    agent_message: 'agent_message',
    'agent/reasoning': 'agent_reasoning',
    agent_reasoning: 'agent_reasoning',
    'agent/reasoning/delta': 'agent_reasoning_delta',
    agent_reasoning_delta: 'agent_reasoning_delta',
    'agent/reasoning/section_break': 'agent_reasoning_section_break',
    agent_reasoning_section_break: 'agent_reasoning_section_break',
    token_count: 'token_count',
    exec_command_begin: 'exec_command_begin',
    exec_command_end: 'exec_command_end',
    exec_approval_request: 'exec_approval_request',
    patch_apply_begin: 'patch_apply_begin',
    patch_apply_end: 'patch_apply_end',
    thread_started: 'thread_started',
    turn_diff: 'turn_diff'
};

const DIRECT_EVENT_TYPES = new Set<string>([
    'task_started',
    'task_complete',
    'turn_aborted',
    'task_failed',
    'stream_error',
    'error',
    'agent_message',
    'agent_reasoning',
    'agent_reasoning_delta',
    'agent_reasoning_section_break',
    'token_count',
    'exec_command_begin',
    'exec_command_end',
    'exec_approval_request',
    'patch_apply_begin',
    'patch_apply_end',
    'thread_started',
    'turn_diff'
]);

function normalizeDirectEventType(value: string): string | null {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/^codex\/event\//, '')
        .replace(/[\s-]+/g, '_');
    const aliased = DIRECT_EVENT_TYPE_ALIASES[normalized];
    if (aliased) return aliased;
    if (DIRECT_EVENT_TYPES.has(normalized)) return normalized;
    return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractItemId(params: Record<string, unknown>): string | null {
    const direct = asString(params.itemId ?? params.item_id ?? params.id);
    if (direct) return direct;

    const item = asRecord(params.item);
    if (item) {
        return asString(item.id ?? item.itemId ?? item.item_id);
    }

    return null;
}

function extractItem(params: Record<string, unknown>): Record<string, unknown> | null {
    const item = asRecord(params.item);
    return item ?? params;
}

function normalizeItemType(value: unknown): string | null {
    const raw = asString(value);
    if (!raw) return null;
    return raw.toLowerCase().replace(/[\s_-]/g, '');
}

function extractCommand(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        const parts = value.filter((part): part is string => typeof part === 'string');
        return parts.length > 0 ? parts.join(' ') : null;
    }
    return null;
}

function extractChanges(value: unknown): Record<string, unknown> | null {
    const record = asRecord(value);
    if (record) return record;

    if (Array.isArray(value)) {
        const changes: Record<string, unknown> = {};
        for (const entry of value) {
            const entryRecord = asRecord(entry);
            if (!entryRecord) continue;
            const path = asString(entryRecord.path ?? entryRecord.file ?? entryRecord.filePath ?? entryRecord.file_path);
            if (path) {
                changes[path] = entryRecord;
            }
        }
        return Object.keys(changes).length > 0 ? changes : null;
    }

    return null;
}

export class AppServerEventConverter {
    private readonly agentMessageBuffers = new Map<string, string>();
    private readonly reasoningBuffers = new Map<string, string>();
    private readonly commandOutputBuffers = new Map<string, string>();
    private readonly commandMeta = new Map<string, Record<string, unknown>>();
    private readonly fileChangeMeta = new Map<string, Record<string, unknown>>();
    private readonly unhandledMethods = new Map<string, { lastLoggedAt: number; suppressed: number }>();
    private static readonly UNHANDLED_LOG_INTERVAL_MS = 30_000;

    private convertDirectEventRecord(record: Record<string, unknown>, typeHint?: string): ConvertedEvent[] {
        const normalizedType = normalizeDirectEventType(asString(record.type) ?? typeHint ?? '');
        if (!normalizedType) return [];

        const willRetry = asBoolean(record.will_retry ?? record.willRetry) ?? false;
        if ((normalizedType === 'error' || normalizedType === 'stream_error') && willRetry) {
            return [];
        }

        const converted: ConvertedEvent = {
            ...record,
            type: normalizedType
        };

        const turnId = asString(record.turn_id ?? record.turnId ?? asRecord(record.turn)?.id);
        if (turnId && converted.turn_id === undefined) {
            converted.turn_id = turnId;
        }

        const threadId = asString(record.thread_id ?? record.threadId ?? asRecord(record.thread)?.id);
        if (threadId && converted.thread_id === undefined) {
            converted.thread_id = threadId;
        }

        if (normalizedType === 'task_failed') {
            const errorMessage = asString(record.error ?? record.message ?? record.reason);
            if (errorMessage && converted.error === undefined) {
                converted.error = errorMessage;
            }
        }

        if (normalizedType === 'error' || normalizedType === 'stream_error') {
            const message = asString(record.message ?? asRecord(record.error)?.message ?? record.reason);
            if (message && converted.message === undefined) {
                converted.message = message;
            }
            const additionalDetails = record.additional_details
                ?? record.additionalDetails
                ?? asRecord(record.error)?.additional_details
                ?? asRecord(record.error)?.additionalDetails;
            if (additionalDetails !== undefined && converted.additional_details === undefined) {
                converted.additional_details = additionalDetails;
            }
        }

        if (normalizedType === 'agent_message') {
            const message = asString(record.message ?? record.text ?? record.content);
            if (message && converted.message === undefined) {
                converted.message = message;
            }
        }

        if (normalizedType === 'agent_reasoning') {
            const text = asString(record.text ?? record.message ?? record.content);
            if (text && converted.text === undefined) {
                converted.text = text;
            }
        }

        return [converted];
    }

    private handleCodexWrappedNotification(method: string, paramsRecord: Record<string, unknown>): ConvertedEvent[] | null {
        if (method !== 'codex/event' && !method.startsWith('codex/event/')) {
            return null;
        }

        const suffix = method.startsWith('codex/event/') ? method.slice('codex/event/'.length) : null;
        const wrapped = asRecord(paramsRecord.msg ?? paramsRecord.event ?? paramsRecord.payload ?? paramsRecord.data);

        if (wrapped) {
            const nestedWrapped = asRecord(wrapped.msg);
            if (nestedWrapped) {
                const nestedEvents = this.convertDirectEventRecord(nestedWrapped);
                if (nestedEvents.length > 0) {
                    return nestedEvents;
                }
            }

            const nestedMethod = asString(wrapped.method ?? wrapped.notification ?? wrapped.name);
            if (nestedMethod && nestedMethod !== method) {
                const nestedParams = asRecord(wrapped.params ?? wrapped.payload ?? wrapped.data) ?? wrapped;
                return this.handleNotification(nestedMethod, nestedParams);
            }

            if (suffix && suffix.includes('/')) {
                const nestedParams = asRecord(wrapped.params ?? wrapped.payload ?? wrapped.data) ?? wrapped;
                const directEvents = this.convertDirectEventRecord(nestedParams, suffix);
                if (directEvents.length > 0) {
                    return directEvents;
                }

                const nestedEvents = this.handleNotification(suffix, nestedParams);
                if (nestedEvents.length > 0) {
                    return nestedEvents;
                }
            }

            const wrappedEvents = this.convertDirectEventRecord(wrapped, suffix ?? undefined);
            if (wrappedEvents.length > 0) {
                return wrappedEvents;
            }
        }

        if (suffix && suffix.includes('/')) {
            const nestedParams = asRecord(paramsRecord.params ?? paramsRecord.payload ?? paramsRecord.data) ?? paramsRecord;
            const directEvents = this.convertDirectEventRecord(nestedParams, suffix);
            if (directEvents.length > 0) {
                return directEvents;
            }

            const nestedEvents = this.handleNotification(suffix, nestedParams);
            if (nestedEvents.length > 0) {
                return nestedEvents;
            }
        }

        if (suffix) {
            const directEvents = this.convertDirectEventRecord(paramsRecord, suffix);
            if (directEvents.length > 0) {
                return directEvents;
            }
        }

        this.logUnhandled(method, paramsRecord);
        return [];
    }

    private handleThreadStatusChanged(paramsRecord: Record<string, unknown>): ConvertedEvent[] {
        const events: ConvertedEvent[] = [];
        const statusRecord = asRecord(paramsRecord.status ?? paramsRecord.threadStatus ?? paramsRecord.thread_status);
        const statusRaw = asString(
            statusRecord?.type
            ?? statusRecord?.status
            ?? statusRecord?.state
            ?? paramsRecord.status
            ?? paramsRecord.state
        );
        const normalizedStatus = statusRaw?.toLowerCase().replace(/[\s_-]/g, '');

        const thread = asRecord(paramsRecord.thread);
        const threadId = asString(paramsRecord.thread_id ?? paramsRecord.threadId ?? thread?.id);
        const turn = asRecord(paramsRecord.turn);
        const turnId = asString(paramsRecord.turn_id ?? paramsRecord.turnId ?? turn?.id);

        if (normalizedStatus === 'systemerror') {
            const systemError = asRecord(
                statusRecord?.systemError
                ?? paramsRecord.systemError
                ?? statusRecord?.error
                ?? paramsRecord.error
            );
            const message = asString(systemError?.message ?? statusRecord?.message ?? paramsRecord.message ?? paramsRecord.reason)
                ?? 'Codex thread entered systemError state';
            const additionalDetails = systemError?.additional_details
                ?? systemError?.additionalDetails
                ?? paramsRecord.additional_details
                ?? paramsRecord.additionalDetails;

            events.push({
                type: 'error',
                message,
                ...(threadId ? { thread_id: threadId } : {}),
                ...(turnId ? { turn_id: turnId } : {}),
                ...(additionalDetails !== undefined ? { additional_details: additionalDetails } : {})
            });
            return events;
        }

        if (normalizedStatus === 'completed' || normalizedStatus === 'complete' || normalizedStatus === 'done') {
            events.push({ type: 'task_complete', ...(turnId ? { turn_id: turnId } : {}) });
            return events;
        }

        if (
            normalizedStatus === 'interrupted'
            || normalizedStatus === 'cancelled'
            || normalizedStatus === 'canceled'
            || normalizedStatus === 'aborted'
        ) {
            events.push({ type: 'turn_aborted', ...(turnId ? { turn_id: turnId } : {}) });
            return events;
        }

        if (normalizedStatus === 'failed' || normalizedStatus === 'error') {
            const errorMessage = asString(
                paramsRecord.message
                ?? paramsRecord.reason
                ?? statusRecord?.message
                ?? asRecord(paramsRecord.error)?.message
            );
            events.push({
                type: 'task_failed',
                ...(turnId ? { turn_id: turnId } : {}),
                ...(errorMessage ? { error: errorMessage } : {})
            });
            return events;
        }

        return events;
    }

    private logUnhandled(method: string, params: unknown): void {
        const now = Date.now();
        const entry = this.unhandledMethods.get(method);
        if (!entry) {
            this.unhandledMethods.set(method, { lastLoggedAt: now, suppressed: 0 });
            logger.debug('[AppServerEventConverter] Unhandled notification', { method, params });
            return;
        }

        if (now - entry.lastLoggedAt < AppServerEventConverter.UNHANDLED_LOG_INTERVAL_MS) {
            entry.suppressed += 1;
            return;
        }

        const suppressed = entry.suppressed;
        entry.lastLoggedAt = now;
        entry.suppressed = 0;
        logger.debug('[AppServerEventConverter] Unhandled notification (throttled)', {
            method,
            suppressed,
            params
        });
    }

    handleNotification(method: string, params: unknown): ConvertedEvent[] {
        const events: ConvertedEvent[] = [];
        const paramsRecord = asRecord(params) ?? {};

        const wrappedEvents = this.handleCodexWrappedNotification(method, paramsRecord);
        if (wrappedEvents !== null) {
            return wrappedEvents;
        }

        if (method === 'thread/started' || method === 'thread/resumed') {
            const thread = asRecord(paramsRecord.thread) ?? paramsRecord;
            const threadId = asString(thread.threadId ?? thread.thread_id ?? thread.id);
            if (threadId) {
                events.push({ type: 'thread_started', thread_id: threadId });
            }
            return events;
        }

        if (method === 'turn/started') {
            const turn = asRecord(paramsRecord.turn) ?? paramsRecord;
            const turnId = asString(turn.turnId ?? turn.turn_id ?? turn.id);
            events.push({ type: 'task_started', ...(turnId ? { turn_id: turnId } : {}) });
            return events;
        }

        if (method === 'turn/completed') {
            const turn = asRecord(paramsRecord.turn) ?? paramsRecord;
            const statusRaw = asString(paramsRecord.status ?? turn.status);
            const status = statusRaw?.toLowerCase();
            const turnId = asString(turn.turnId ?? turn.turn_id ?? turn.id);
            const errorMessage = asString(paramsRecord.error ?? paramsRecord.message ?? paramsRecord.reason);

            if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') {
                events.push({ type: 'turn_aborted', ...(turnId ? { turn_id: turnId } : {}) });
                return events;
            }

            if (status === 'failed' || status === 'error') {
                events.push({ type: 'task_failed', ...(turnId ? { turn_id: turnId } : {}), ...(errorMessage ? { error: errorMessage } : {}) });
                return events;
            }

            events.push({ type: 'task_complete', ...(turnId ? { turn_id: turnId } : {}) });
            return events;
        }

        if (method === 'thread/status/changed') {
            return this.handleThreadStatusChanged(paramsRecord);
        }

        if (method === 'turn/diff/updated') {
            const diff = asString(paramsRecord.diff ?? paramsRecord.unified_diff ?? paramsRecord.unifiedDiff);
            if (diff) {
                events.push({ type: 'turn_diff', unified_diff: diff });
            }
            return events;
        }

        if (method === 'thread/tokenUsage/updated') {
            const info = asRecord(paramsRecord.tokenUsage ?? paramsRecord.token_usage ?? paramsRecord) ?? {};
            events.push({ type: 'token_count', info });
            return events;
        }

        if (method === 'error') {
            const willRetry = asBoolean(paramsRecord.will_retry ?? paramsRecord.willRetry) ?? false;
            if (willRetry) return events;
            const message = asString(paramsRecord.message ?? paramsRecord.reason) ?? asString(asRecord(paramsRecord.error)?.message);
            const additionalDetails = paramsRecord.additional_details
                ?? paramsRecord.additionalDetails
                ?? asRecord(paramsRecord.error)?.additional_details
                ?? asRecord(paramsRecord.error)?.additionalDetails;
            if (message) {
                events.push({
                    type: 'error',
                    message,
                    ...(additionalDetails !== undefined ? { additional_details: additionalDetails } : {})
                });
            }
            return events;
        }

        if (method === 'stream_error') {
            const willRetry = asBoolean(paramsRecord.will_retry ?? paramsRecord.willRetry) ?? false;
            if (willRetry) return events;
            const message = asString(paramsRecord.message ?? paramsRecord.reason) ?? asString(asRecord(paramsRecord.error)?.message);
            const additionalDetails = paramsRecord.additional_details
                ?? paramsRecord.additionalDetails
                ?? asRecord(paramsRecord.error)?.additional_details
                ?? asRecord(paramsRecord.error)?.additionalDetails;
            if (message) {
                events.push({
                    type: 'stream_error',
                    message,
                    ...(additionalDetails !== undefined ? { additional_details: additionalDetails } : {})
                });
            }
            return events;
        }

        if (method === 'item/agentMessage/delta') {
            const itemId = extractItemId(paramsRecord);
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.message);
            if (itemId && delta) {
                const prev = this.agentMessageBuffers.get(itemId) ?? '';
                this.agentMessageBuffers.set(itemId, prev + delta);
            }
            return events;
        }

        if (method === 'item/reasoning/textDelta') {
            const itemId = extractItemId(paramsRecord) ?? 'reasoning';
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.message);
            if (delta) {
                const prev = this.reasoningBuffers.get(itemId) ?? '';
                this.reasoningBuffers.set(itemId, prev + delta);
                events.push({ type: 'agent_reasoning_delta', delta });
            }
            return events;
        }

        if (method === 'item/reasoning/summaryPartAdded') {
            events.push({ type: 'agent_reasoning_section_break' });
            return events;
        }

        if (method === 'item/commandExecution/outputDelta') {
            const itemId = extractItemId(paramsRecord);
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.output ?? paramsRecord.stdout);
            if (itemId && delta) {
                const prev = this.commandOutputBuffers.get(itemId) ?? '';
                this.commandOutputBuffers.set(itemId, prev + delta);
            }
            return events;
        }

        if (method === 'item/started' || method === 'item/completed') {
            const item = extractItem(paramsRecord);
            if (!item) return events;

            const itemType = normalizeItemType(item.type ?? item.itemType ?? item.kind);
            const itemId = extractItemId(paramsRecord) ?? asString(item.id ?? item.itemId ?? item.item_id);

            if (!itemType || !itemId) {
                return events;
            }

            if (itemType === 'agentmessage') {
                if (method === 'item/completed') {
                    const text = asString(item.text ?? item.message ?? item.content) ?? this.agentMessageBuffers.get(itemId);
                    if (text) {
                        events.push({ type: 'agent_message', message: text });
                    }
                    this.agentMessageBuffers.delete(itemId);
                }
                return events;
            }

            if (itemType === 'reasoning') {
                if (method === 'item/completed') {
                    const text = asString(item.text ?? item.message ?? item.content) ?? this.reasoningBuffers.get(itemId);
                    if (text) {
                        events.push({ type: 'agent_reasoning', text });
                    }
                    this.reasoningBuffers.delete(itemId);
                }
                return events;
            }

            if (itemType === 'commandexecution') {
                if (method === 'item/started') {
                    const command = extractCommand(item.command ?? item.cmd ?? item.args);
                    const cwd = asString(item.cwd ?? item.workingDirectory ?? item.working_directory);
                    const autoApproved = asBoolean(item.autoApproved ?? item.auto_approved);
                    const meta: Record<string, unknown> = {};
                    if (command) meta.command = command;
                    if (cwd) meta.cwd = cwd;
                    if (autoApproved !== null) meta.auto_approved = autoApproved;
                    this.commandMeta.set(itemId, meta);

                    events.push({
                        type: 'exec_command_begin',
                        call_id: itemId,
                        ...meta
                    });
                }

                if (method === 'item/completed') {
                    const meta = this.commandMeta.get(itemId) ?? {};
                    const output = asString(item.output ?? item.result ?? item.stdout) ?? this.commandOutputBuffers.get(itemId);
                    const stderr = asString(item.stderr);
                    const error = asString(item.error);
                    const exitCode = asNumber(item.exitCode ?? item.exit_code ?? item.exitcode);
                    const status = asString(item.status);

                    events.push({
                        type: 'exec_command_end',
                        call_id: itemId,
                        ...meta,
                        ...(output ? { output } : {}),
                        ...(stderr ? { stderr } : {}),
                        ...(error ? { error } : {}),
                        ...(exitCode !== null ? { exit_code: exitCode } : {}),
                        ...(status ? { status } : {})
                    });

                    this.commandMeta.delete(itemId);
                    this.commandOutputBuffers.delete(itemId);
                }

                return events;
            }

            if (itemType === 'filechange') {
                if (method === 'item/started') {
                    const changes = extractChanges(item.changes ?? item.change ?? item.diff);
                    const autoApproved = asBoolean(item.autoApproved ?? item.auto_approved);
                    const meta: Record<string, unknown> = {};
                    if (changes) meta.changes = changes;
                    if (autoApproved !== null) meta.auto_approved = autoApproved;
                    this.fileChangeMeta.set(itemId, meta);

                    events.push({
                        type: 'patch_apply_begin',
                        call_id: itemId,
                        ...meta
                    });
                }

                if (method === 'item/completed') {
                    const meta = this.fileChangeMeta.get(itemId) ?? {};
                    const stdout = asString(item.stdout ?? item.output);
                    const stderr = asString(item.stderr);
                    const success = asBoolean(item.success ?? item.ok ?? item.applied ?? item.status === 'completed');

                    events.push({
                        type: 'patch_apply_end',
                        call_id: itemId,
                        ...meta,
                        ...(stdout ? { stdout } : {}),
                        ...(stderr ? { stderr } : {}),
                        success: success ?? false
                    });

                    this.fileChangeMeta.delete(itemId);
                }

                return events;
            }
        }

        this.logUnhandled(method, params);
        return events;
    }

    reset(): void {
        this.agentMessageBuffers.clear();
        this.reasoningBuffers.clear();
        this.commandOutputBuffers.clear();
        this.commandMeta.clear();
        this.fileChangeMeta.clear();
    }
}
