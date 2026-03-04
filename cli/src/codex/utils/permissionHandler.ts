/**
 * Permission Handler for Codex tool approval integration
 * 
 * Handles tool permission requests and responses for Codex sessions.
 * Simpler than Claude's permission handler since we get tool IDs directly.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import {
    BasePermissionHandler,
    type PendingPermissionRequest,
    type PermissionCompletion
} from "@/modules/common/permission/BasePermissionHandler";

interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
    // Flat (AskUserQuestion) or nested (request_user_input)
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
}

interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
}

type CodexPermissionHandlerOptions = {
    onRequest?: (request: { id: string; toolName: string; input: unknown }) => void;
    onComplete?: (result: {
        id: string;
        toolName: string;
        input: unknown;
        approved: boolean;
        decision: PermissionResult['decision'];
        reason?: string;
        answers?: PermissionResult['answers'];
    }) => void;
};

function isUserInputToolName(toolName: string): boolean {
    return toolName === 'AskUserQuestion'
        || toolName === 'ask_user_question'
        || toolName === 'request_user_input';
}

function normalizeAnswers(
    answers: Record<string, string[]> | Record<string, { answers: string[] }> | undefined
): Record<string, string[]> {
    if (!answers || typeof answers !== 'object') {
        return {};
    }

    const normalized: Record<string, string[]> = {};

    for (const [key, value] of Object.entries(answers)) {
        if (Array.isArray(value)) {
            const filtered = value.filter((item): item is string => typeof item === 'string');
            normalized[key] = filtered;
            continue;
        }

        if (!value || typeof value !== 'object') {
            continue;
        }

        const nested = value as { answers?: unknown };
        if (!Array.isArray(nested.answers)) {
            continue;
        }

        const filtered = nested.answers.filter((item): item is string => typeof item === 'string');
        normalized[key] = filtered;
    }

    return normalized;
}

export class CodexPermissionHandler extends BasePermissionHandler<PermissionResponse, PermissionResult> {
    constructor(session: ApiSessionClient, private readonly options?: CodexPermissionHandlerOptions) {
        super(session);
    }

    protected override onRequestRegistered(id: string, toolName: string, input: unknown): void {
        this.options?.onRequest?.({ id, toolName, input });
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.addPendingRequest(toolCallId, toolName, input, { resolve, reject });

            // Send push notification
            // this.session.api.push().sendToAllDevices(
            //     'Permission Request',
            //     `Codex wants to use ${toolName}`,
            //     {
            //         sessionId: this.session.sessionId,
            //         requestId: toolCallId,
            //         tool: toolName,
            //         type: 'permission_request'
            //     }
            // );

            logger.debug(`[Codex] Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }

    /**
     * Handle user-input (questionnaire) requests from Codex app-server.
     *
     * Uses the same permission plumbing so the web UI can render a question tool card.
     */
    async handleUserInputRequest(
        requestId: string,
        toolName: string,
        input: unknown
    ): Promise<Record<string, string[]>> {
        const result = await this.handleToolCall(requestId, toolName, input);

        const normalized = normalizeAnswers(result.answers);
        if (Object.keys(normalized).length === 0) {
            throw new Error('No answers were provided.');
        }

        return normalized;
    }

    /**
     * Handle permission responses
     */
    protected async handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingPermissionRequest<PermissionResult>
    ): Promise<PermissionCompletion> {
        const reason = typeof response.reason === 'string' ? response.reason : undefined;
        const answers = response.answers;
        const result: PermissionResult = response.approved
            ? {
                decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved',
                reason,
                answers
            }
            : {
                decision: response.decision === 'denied' ? 'denied' : 'abort',
                reason,
                answers
            };

        const wantsAnswers = isUserInputToolName(pending.toolName);
        if (wantsAnswers) {
            const normalized = normalizeAnswers(response.answers);
            const hasAnswers = Object.keys(normalized).length > 0;

            if (!response.approved || !hasAnswers) {
                const fallbackReason = reason ?? 'No answers were provided.';
                pending.resolve({
                    decision: response.approved ? 'abort' : result.decision,
                    reason: fallbackReason
                });

                logger.debug(`[Codex] User input request denied for ${pending.toolName}`);

                this.options?.onComplete?.({
                    id: response.id,
                    toolName: pending.toolName,
                    input: pending.input,
                    approved: false,
                    decision: response.approved ? 'abort' : result.decision,
                    reason: fallbackReason
                });

                return {
                    status: 'denied',
                    decision: response.approved ? 'abort' : result.decision,
                    reason: fallbackReason,
                    answers: response.answers
                };
            }
        }

        pending.resolve(result);
        logger.debug(`[Codex] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);

        this.options?.onComplete?.({
            id: response.id,
            toolName: pending.toolName,
            input: pending.input,
            approved: response.approved,
            decision: result.decision,
            reason: result.reason,
            ...(result.answers ? { answers: result.answers } : {})
        });

        return {
            status: response.approved ? 'approved' : 'denied',
            decision: result.decision,
            reason: result.reason,
            answers: result.answers
        };
    }

    protected handleMissingPendingResponse(_response: PermissionResponse): void {
        logger.debug('[Codex] Permission request not found or already resolved');
    }

    /**
     * Reset state for new sessions
     */
    reset(): void {
        this.cancelPendingRequests({
            completedReason: 'Session reset',
            rejectMessage: 'Session reset'
        });

        logger.debug('[Codex] Permission handler reset');
    }
}
