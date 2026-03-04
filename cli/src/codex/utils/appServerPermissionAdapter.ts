import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { CodexPermissionHandler } from './permissionHandler';
import type { CodexAppServerClient } from '../codexAppServerClient';

type PermissionDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';

type PermissionResult = {
    decision: PermissionDecision;
    reason?: string;
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mapDecision(decision: PermissionDecision): { decision: string } {
    switch (decision) {
        case 'approved':
            return { decision: 'accept' };
        case 'approved_for_session':
            return { decision: 'acceptForSession' };
        case 'denied':
            return { decision: 'decline' };
        case 'abort':
            return { decision: 'cancel' };
    }
}

type DynamicToolCallResponse = {
    success: boolean;
    contentItems: Array<
        | { type: 'inputText'; text: string }
        | { type: 'inputImage'; imageUrl: string }
    >;
};

function buildDynamicToolFailure(toolName: string, reason?: string): DynamicToolCallResponse {
    const message = reason && reason.trim().length > 0
        ? reason
        : `Tool '${toolName}' was rejected by user`;
    return {
        success: false,
        contentItems: [{ type: 'inputText', text: message }]
    };
}

function toJsonText(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value ?? {});
    } catch {
        return String(value);
    }
}

export function registerAppServerPermissionHandlers(args: {
    client: CodexAppServerClient;
    permissionHandler: CodexPermissionHandler;
    onUserInputRequest?: (request: unknown) => Promise<Record<string, string[]>>;
}): void {
    const { client, permissionHandler, onUserInputRequest } = args;

    client.registerRequestHandler('item/commandExecution/requestApproval', async (params) => {
        const record = asRecord(params) ?? {};
        const toolCallId = asString(record.itemId) ?? randomUUID();
        const reason = asString(record.reason);
        const command = record.command;
        const cwd = asString(record.cwd);

        const result = await permissionHandler.handleToolCall(
            toolCallId,
            'CodexBash',
            {
                message: reason,
                command,
                cwd
            }
        ) as PermissionResult;

        return mapDecision(result.decision);
    });

    client.registerRequestHandler('item/fileChange/requestApproval', async (params) => {
        const record = asRecord(params) ?? {};
        const toolCallId = asString(record.itemId) ?? randomUUID();
        const reason = asString(record.reason);
        const grantRoot = asString(record.grantRoot);

        const result = await permissionHandler.handleToolCall(
            toolCallId,
            'CodexPatch',
            {
                message: reason,
                grantRoot
            }
        ) as PermissionResult;

        return mapDecision(result.decision);
    });

    client.registerRequestHandler('item/tool/requestUserInput', async (params) => {
        if (!onUserInputRequest) {
            logger.debug('[CodexAppServer] No user-input handler registered; cancelling request');
            return { decision: 'cancel' };
        }

        try {
            const answers = await onUserInputRequest(params);
            return {
                decision: 'accept',
                answers
            };
        } catch (error) {
            logger.debug('[CodexAppServer] User-input request failed; cancelling', { error });
            return { decision: 'cancel' };
        }
    });

    client.registerRequestHandler('item/tool/call', async (params) => {
        const record = asRecord(params) ?? {};
        const toolCallId = asString(record.callId ?? record.call_id) ?? randomUUID();
        const toolName = asString(record.tool) ?? 'unknown_tool';
        const toolArgs = record.arguments;

        const result = await permissionHandler.handleToolCall(
            toolCallId,
            toolName,
            toolArgs
        ) as PermissionResult;

        if (result.decision !== 'approved' && result.decision !== 'approved_for_session') {
            return buildDynamicToolFailure(toolName, result.reason);
        }

        return {
            success: true,
            contentItems: [
                {
                    type: 'inputText',
                    text: toJsonText({
                        ok: true,
                        tool: toolName,
                        answers: result.answers ?? {},
                        reason: result.reason ?? null
                    })
                }
            ]
        } satisfies DynamicToolCallResponse;
    });
}
