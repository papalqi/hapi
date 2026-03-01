import React from 'react';
import { randomUUID } from 'node:crypto';

import { CodexMcpClient } from './codexMcpClient';
import { CodexAppServerClient } from './codexAppServerClient';
import { CodexSdkClient } from './codexSdkClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { logger } from '@/ui/logger';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import type { CodexSessionConfig } from './types';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { emitReadyIfIdle } from './utils/emitReadyIfIdle';
import type { CodexSession } from './session';
import type { EnhancedMode } from './loop';
import { hasCodexCliOverrides } from './utils/codexCliOverrides';
import { buildCodexStartConfig } from './utils/codexStartConfig';
import { AppServerEventConverter } from './utils/appServerEventConverter';
import { registerAppServerPermissionHandlers } from './utils/appServerPermissionAdapter';
import { buildThreadStartParams, buildTurnStartParams } from './utils/appServerConfig';
import { buildCodexSdkOptions, buildCodexSdkThreadOptions } from './utils/codexSdkConfig';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';

type HappyServer = Awaited<ReturnType<typeof buildHapiMcpBridge>>['server'];

type CodexRemoteTransport = 'app-server' | 'mcp' | 'sdk';

function resolveTransport(): CodexRemoteTransport {
    if (process.env.CODEX_USE_SDK === '1') {
        return 'sdk';
    }
    if (process.env.CODEX_USE_MCP_SERVER === '1') {
        return 'mcp';
    }
    return 'app-server';
}

class CodexRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CodexSession;
    private readonly transport: CodexRemoteTransport;
    private readonly useAppServer: boolean;
    private readonly useSdk: boolean;
    private readonly mcpClient: CodexMcpClient | null;
    private readonly appServerClient: CodexAppServerClient | null;
    private readonly sdkClient: CodexSdkClient | null;
    private permissionHandler: CodexPermissionHandler | null = null;
    private reasoningProcessor: ReasoningProcessor | null = null;
    private diffProcessor: DiffProcessor | null = null;
    private happyServer: HappyServer | null = null;
    private abortController: AbortController = new AbortController();
    private currentThreadId: string | null = null;
    private currentTurnId: string | null = null;

    constructor(session: CodexSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.transport = resolveTransport();
        this.useAppServer = this.transport === 'app-server';
        this.useSdk = this.transport === 'sdk';
        this.mcpClient = this.transport === 'mcp' ? new CodexMcpClient() : null;
        this.appServerClient = this.transport === 'app-server' ? new CodexAppServerClient() : null;
        this.sdkClient = this.transport === 'sdk' ? new CodexSdkClient() : null;
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(CodexDisplay, context);
    }

    private async handleAbort(): Promise<void> {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            if (this.useAppServer && this.appServerClient) {
                if (this.currentThreadId && this.currentTurnId) {
                    try {
                        await this.appServerClient.interruptTurn({
                            threadId: this.currentThreadId,
                            turnId: this.currentTurnId
                        });
                    } catch (error) {
                        logger.debug('[Codex] Error interrupting app-server turn:', error);
                    }
                }

                this.currentTurnId = null;
            }

            if (this.useSdk && this.sdkClient) {
                if (this.currentTurnId) {
                    try {
                        await this.sdkClient.interruptTurn();
                    } catch (error) {
                        logger.debug('[Codex] Error interrupting SDK turn:', error);
                    }
                }

                this.currentTurnId = null;
            }

            this.abortController.abort();
            this.session.queue.reset();
            this.permissionHandler?.reset();
            this.reasoningProcessor?.abort();
            this.diffProcessor?.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            this.abortController = new AbortController();
        }
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Exiting agent via Ctrl-C');
        this.exitReason = 'exit';
        this.shouldExit = true;
        await this.handleAbort();
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Switching to local mode via double space');
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort();
    }

    private async handleSwitchRequest(): Promise<void> {
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort();
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        if (this.session.codexArgs && this.session.codexArgs.length > 0) {
            if (hasCodexCliOverrides(this.session.codexCliOverrides)) {
                logger.debug(`[codex-remote] CLI args include sandbox/approval overrides; other args ` +
                    `are ignored in remote mode.`);
            } else {
                logger.debug(`[codex-remote] Warning: CLI args [${this.session.codexArgs.join(', ')}] are ignored in remote mode. ` +
                    `Remote mode uses message-based configuration (model/sandbox set via web interface).`);
            }
        }

        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;
        const useAppServer = this.useAppServer;
        const useSdk = this.useSdk;
        const useAsyncTurnClient = useAppServer || useSdk;
        const mcpClient = this.mcpClient;
        const appServerClient = this.appServerClient;
        const sdkClient = this.sdkClient;
        const appServerEventConverter = useAppServer ? new AppServerEventConverter() : null;

        const normalizeCommand = (value: unknown): string | undefined => {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                return trimmed.length > 0 ? trimmed : undefined;
            }
            if (Array.isArray(value)) {
                const joined = value.filter((part): part is string => typeof part === 'string').join(' ');
                return joined.length > 0 ? joined : undefined;
            }
            return undefined;
        };

        const asRecord = (value: unknown): Record<string, unknown> | null => {
            if (!value || typeof value !== 'object') {
                return null;
            }
            return value as Record<string, unknown>;
        };

        const asString = (value: unknown): string | null => {
            return typeof value === 'string' && value.length > 0 ? value : null;
        };

        const formatOutputPreview = (value: unknown): string => {
            if (typeof value === 'string') return value;
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            if (value === null || value === undefined) return '';
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        };

        const normalizeChanges = (value: unknown): Record<string, unknown> => {
            const record = asRecord(value);
            if (record) {
                return record;
            }

            if (!Array.isArray(value)) {
                return {};
            }

            const normalized: Record<string, unknown> = {};
            for (const entry of value) {
                const entryRecord = asRecord(entry);
                if (!entryRecord) continue;
                const path = asString(entryRecord.path ?? entryRecord.file ?? entryRecord.filePath ?? entryRecord.file_path);
                if (!path) continue;
                normalized[path] = entryRecord;
            }

            return normalized;
        };

        const normalizeTodoEntries = (value: unknown): Array<{
            content: string;
            priority: 'high' | 'medium' | 'low';
            status: 'pending' | 'in_progress' | 'completed';
        }> => {
            if (!Array.isArray(value)) return [];
            const entries: Array<{
                content: string;
                priority: 'high' | 'medium' | 'low';
                status: 'pending' | 'in_progress' | 'completed';
            }> = [];

            for (const item of value) {
                const record = asRecord(item);
                if (!record) continue;
                const content = asString(record.text ?? record.content ?? record.description ?? record.title);
                if (!content) continue;

                const rawStatus = asString(record.status);
                const completed = record.completed === true;
                const status: 'pending' | 'in_progress' | 'completed' =
                    completed
                        ? 'completed'
                        : rawStatus === 'in_progress' || rawStatus === 'in-progress'
                            ? 'in_progress'
                            : rawStatus === 'completed'
                                ? 'completed'
                                : 'pending';

                const rawPriority = asString(record.priority);
                const priority: 'high' | 'medium' | 'low' =
                    rawPriority === 'high' || rawPriority === 'low' || rawPriority === 'medium'
                        ? rawPriority
                        : 'medium';

                entries.push({
                    content,
                    priority,
                    status
                });
            }

            return entries;
        };

        const unwrapMcpWrapperEvent = (msg: Record<string, unknown>): Record<string, unknown> | null => {
            const wrapperType = asString(msg.type);
            const payload = asRecord(msg.payload);
            if (!wrapperType || !payload) {
                return null;
            }

            if (wrapperType === 'event_msg') {
                const payloadTypeRaw = asString(payload.type);
                if (!payloadTypeRaw) return null;

                const payloadType = payloadTypeRaw
                    .trim()
                    .toLowerCase()
                    .replace(/^codex\/event\//, '')
                    .replace(/[\/\s-]+/g, '_');

                if (payloadType === 'plan') {
                    return {
                        ...payload,
                        type: 'todo_list',
                        items: payload.items ?? payload.todos ?? payload.entries
                    };
                }

                return {
                    ...payload,
                    type: payloadType
                };
            }

            return null;
        };

        const shouldForceSessionReset = (rawMessage: string): boolean => {
            const message = rawMessage.toLowerCase();
            return (
                message.includes('no active session') ||
                message.includes('session not found') ||
                message.includes('conversation not found') ||
                message.includes('invalid session') ||
                message.includes('invalid conversation') ||
                message.includes('thread not found')
            );
        };

        const permissionHandler = new CodexPermissionHandler(session.client, {
            onRequest: ({ id, toolName, input }) => {
                const inputRecord = input && typeof input === 'object' ? input as Record<string, unknown> : {};
                const message = typeof inputRecord.message === 'string' ? inputRecord.message : undefined;
                const rawCommand = inputRecord.command;
                const command = Array.isArray(rawCommand)
                    ? rawCommand.filter((part): part is string => typeof part === 'string').join(' ')
                    : typeof rawCommand === 'string'
                        ? rawCommand
                        : undefined;
                const cwdValue = inputRecord.cwd;
                const cwd = typeof cwdValue === 'string' && cwdValue.trim().length > 0 ? cwdValue : undefined;

                session.sendCodexMessage({
                    type: 'tool-call',
                    name: 'CodexPermission',
                    callId: id,
                    input: {
                        tool: toolName,
                        message,
                        command,
                        cwd
                    },
                    id: randomUUID()
                });
            },
            onComplete: ({ id, decision, reason, approved }) => {
                session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId: id,
                    output: {
                        decision,
                        reason
                    },
                    is_error: !approved,
                    id: randomUUID()
                });
            }
        });
        const reasoningProcessor = new ReasoningProcessor((message) => {
            session.sendCodexMessage(message);
        });
        const diffProcessor = new DiffProcessor((message) => {
            session.sendCodexMessage(message);
        });
        this.permissionHandler = permissionHandler;
        this.reasoningProcessor = reasoningProcessor;
        this.diffProcessor = diffProcessor;

        let wasCreated = false;
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        let first = true;
        let turnInFlight = false;

        const TURN_WATCHDOG_PROGRESS_TIMEOUT_MS = 90_000;
        const TURN_WATCHDOG_CHECK_INTERVAL_MS = 5_000;
        let turnWatchdogTimer: NodeJS.Timeout | null = null;
        let lastTurnProgressAt = 0;
        let turnWatchdogNotified = false;

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        const syncSessionId = () => {
            if (!mcpClient) return;
            const clientSessionId = mcpClient.getSessionId();
            if (clientSessionId && clientSessionId !== session.sessionId) {
                session.onSessionFound(clientSessionId);
            }
        };

        const formatAdditionalDetails = (value: unknown): string | null => {
            if (value === null || value === undefined) return null;
            const preview = formatOutputPreview(value).trim();
            if (preview.length === 0) return null;
            if (preview.length <= 600) return preview;
            return `${preview.slice(0, 600)}...`;
        };

        const markTurnProgress = () => {
            if (!useAsyncTurnClient || !turnInFlight) return;
            lastTurnProgressAt = Date.now();
        };

        const clearTurnWatchdog = () => {
            if (turnWatchdogTimer) {
                clearInterval(turnWatchdogTimer);
                turnWatchdogTimer = null;
            }
            lastTurnProgressAt = 0;
            turnWatchdogNotified = false;
        };

        const startTurnTracking = () => {
            if (!useAsyncTurnClient) return;
            turnInFlight = true;
            lastTurnProgressAt = Date.now();
            turnWatchdogNotified = false;
            if (!session.thinking) {
                logger.debug('thinking started');
                session.onThinkingChange(true);
            }
            if (!turnWatchdogTimer) {
                turnWatchdogTimer = setInterval(() => {
                    if (this.shouldExit || !turnInFlight) {
                        return;
                    }
                    const idleForMs = Date.now() - lastTurnProgressAt;
                    if (turnWatchdogNotified || idleForMs < TURN_WATCHDOG_PROGRESS_TIMEOUT_MS) {
                        return;
                    }
                    turnWatchdogNotified = true;
                    const warning = 'Codex might be stuck (no visible progress for 90s). Try Abort, Recover Session, or reconnect.';
                    messageBuffer.addMessage(warning, 'status');
                    session.sendSessionEvent({ type: 'message', message: warning });
                }, TURN_WATCHDOG_CHECK_INTERVAL_MS);
                turnWatchdogTimer.unref?.();
            }
        };

        const clearTurnTracking = (reason: string) => {
            if (useAsyncTurnClient) {
                turnInFlight = false;
                clearTurnWatchdog();
            }
            this.currentTurnId = null;
            if (session.thinking) {
                logger.debug(`thinking completed (${reason})`);
                session.onThinkingChange(false);
            }
            permissionHandler.reset();
            reasoningProcessor.abort();
            diffProcessor.reset();
            appServerEventConverter?.reset();
        };

        const shouldTreatAsTerminalEvent = (msgType: string, msg: Record<string, unknown>): boolean => {
            if (msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed') {
                return true;
            }
            if (msgType === 'error' || msgType === 'stream_error') {
                return (msg.will_retry === true || msg.willRetry === true) ? false : true;
            }
            return false;
        };

        const handleCodexEvent = (msg: Record<string, unknown>) => {
            const msgType = asString(msg.type);
            if (!msgType) return;

            if (!useAppServer && !useSdk && (msgType === 'event_msg' || msgType === 'response_item')) {
                const unwrapped = unwrapMcpWrapperEvent(msg);
                if (unwrapped) {
                    handleCodexEvent(unwrapped);
                    return;
                }
            }

            const isTerminalEvent = shouldTreatAsTerminalEvent(msgType, msg);

            if (msgType === 'thread_started') {
                const threadId = asString(msg.thread_id ?? msg.threadId);
                if (threadId) {
                    this.currentThreadId = threadId;
                    session.onSessionFound(threadId);
                }
                return;
            }

            if (msgType === 'task_started') {
                const turnId = asString(msg.turn_id ?? msg.turnId);
                if (turnId) {
                    this.currentTurnId = turnId;
                }
                if (useAsyncTurnClient) {
                    startTurnTracking();
                } else if (!session.thinking) {
                    logger.debug('thinking started');
                    session.onThinkingChange(true);
                }
            }

            if (isTerminalEvent) {
                this.currentTurnId = null;
            }

            if (!useAppServer && !useSdk) {
                logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

                if (msgType === 'event_msg' || msgType === 'response_item' || msgType === 'session_meta') {
                    const payload = asRecord(msg.payload);
                    const payloadType = asString(payload?.type);
                    logger.debug(`[Codex] MCP wrapper event type: ${msgType}${payloadType ? ` (payload=${payloadType})` : ''}`);
                }
            }

            if (useAsyncTurnClient && turnInFlight) {
                markTurnProgress();
            }

            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    messageBuffer.addMessage(message, 'assistant');
                }
            } else if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    messageBuffer.addMessage(`[Thinking] ${text.substring(0, 100)}...`, 'system');
                }
            } else if (msgType === 'exec_command_begin') {
                const command = normalizeCommand(msg.command) ?? 'command';
                messageBuffer.addMessage(`Executing: ${command}`, 'tool');
            } else if (msgType === 'exec_command_end') {
                const output = msg.output ?? msg.error ?? 'Command completed';
                const outputText = formatOutputPreview(output);
                const truncatedOutput = outputText.substring(0, 200);
                messageBuffer.addMessage(
                    `Result: ${truncatedOutput}${outputText.length > 200 ? '...' : ''}`,
                    'result'
                );
            } else if (msgType === 'task_started') {
                messageBuffer.addMessage('Starting task...', 'status');
            } else if (msgType === 'task_complete') {
                messageBuffer.addMessage('Task completed', 'status');
            } else if (msgType === 'turn_aborted') {
                messageBuffer.addMessage('Turn aborted', 'status');
            } else if (msgType === 'task_failed') {
                const error = asString(msg.error);
                messageBuffer.addMessage(error ? `Task failed: ${error}` : 'Task failed', 'status');
            } else if (msgType === 'stream_error') {
                const message = asString(msg.message) ?? 'Stream error';
                const additionalDetails = msg.additional_details ?? msg.additionalDetails;
                const detailsText = formatAdditionalDetails(additionalDetails);
                messageBuffer.addMessage(`Error: ${message}`, 'status');
                session.sendSessionEvent({
                    type: 'message',
                    message: detailsText
                        ? `Stream error: ${message}\nDetails: ${detailsText}`
                        : `Stream error: ${message}`
                });
                if (shouldForceSessionReset(message)) {
                    wasCreated = false;
                    currentModeHash = null;
                    mcpClient?.clearSession();
                    sdkClient?.clearThread();
                    logger.debug('[Codex] Forced session reset after stream error (session invalid)');
                } else {
                    logger.debug('[Codex] Keeping session state after stream error to preserve context');
                }
            } else if (msgType === 'error') {
                const message = asString(msg.message) ?? 'Unknown error';
                const additionalDetails = msg.additional_details ?? msg.additionalDetails;
                const detailsText = formatAdditionalDetails(additionalDetails);
                messageBuffer.addMessage(`Error: ${message}`, 'status');
                session.sendSessionEvent({
                    type: 'message',
                    message: detailsText
                        ? `Codex error: ${message}\nDetails: ${detailsText}`
                        : `Codex error: ${message}`
                });
                if (shouldForceSessionReset(message)) {
                    wasCreated = false;
                    currentModeHash = null;
                    mcpClient?.clearSession();
                    sdkClient?.clearThread();
                    logger.debug('[Codex] Forced session reset after API error (session invalid)');
                } else {
                    logger.debug('[Codex] Keeping session state after API error to preserve context');
                }
            }

            if (isTerminalEvent) {
                clearTurnTracking(msgType);
                sendReady();
            }
            if (msgType === 'agent_reasoning_section_break') {
                reasoningProcessor.handleSectionBreak();
            }
            if (msgType === 'agent_reasoning_delta') {
                const delta = asString(msg.delta);
                if (delta) {
                    reasoningProcessor.processDelta(delta);
                }
            }
            if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    reasoningProcessor.complete(text);
                }
            }
            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    session.sendCodexMessage({
                        type: 'message',
                        message,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'exec_command_begin' || msgType === 'exec_approval_request') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const inputs: Record<string, unknown> = { ...msg };
                    delete inputs.type;
                    delete inputs.call_id;
                    delete inputs.callId;

                    session.sendCodexMessage({
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId: callId,
                        input: inputs,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'exec_command_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const output: Record<string, unknown> = { ...msg };
                    delete output.type;
                    delete output.call_id;
                    delete output.callId;

                    session.sendCodexMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'token_count') {
                session.sendCodexMessage({
                    ...msg,
                    id: randomUUID()
                });
            }
            if (msgType === 'todo_list') {
                const entries = normalizeTodoEntries(msg.items ?? msg.todos ?? msg.entries);
                if (entries.length > 0) {
                    session.sendCodexMessage({
                        type: 'plan',
                        entries
                    });
                }
            }
            if (msgType === 'plan') {
                const entries = normalizeTodoEntries(msg.entries ?? msg.items ?? msg.todos);
                if (entries.length > 0) {
                    session.sendCodexMessage({
                        type: 'plan',
                        entries
                    });
                }
            }
            if (msgType === 'patch_apply_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const changes = normalizeChanges(msg.changes);
                    const changeCount = Object.keys(changes).length;
                    const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
                    messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

                    session.sendCodexMessage({
                        type: 'tool-call',
                        name: 'CodexPatch',
                        callId: callId,
                        input: {
                            auto_approved: msg.auto_approved ?? msg.autoApproved,
                            changes
                        },
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'patch_apply_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const stdout = asString(msg.stdout);
                    const stderr = asString(msg.stderr);
                    const success = Boolean(msg.success);

                    if (success) {
                        const message = stdout || 'Files modified successfully';
                        messageBuffer.addMessage(message.substring(0, 200), 'result');
                    } else {
                        const errorMsg = stderr || 'Failed to modify files';
                        messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
                    }

                    session.sendCodexMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output: {
                            stdout,
                            stderr,
                            success
                        },
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'turn_diff') {
                const diff = asString(msg.unified_diff);
                if (diff) {
                    diffProcessor.processDiff(diff);
                }
            }
        };

        if (useAppServer && appServerClient && appServerEventConverter) {
            registerAppServerPermissionHandlers({
                client: appServerClient,
                permissionHandler
            });

            appServerClient.setNotificationHandler((method, params) => {
                const events = appServerEventConverter.handleNotification(method, params);
                for (const event of events) {
                    const eventRecord = asRecord(event) ?? { type: undefined };
                    handleCodexEvent(eventRecord);
                }
            });
        } else if (useSdk && sdkClient) {
            sdkClient.setHandler((event) => {
                const eventRecord = asRecord(event) ?? { type: undefined };
                handleCodexEvent(eventRecord);
            });
        } else if (mcpClient) {
            mcpClient.setPermissionHandler(permissionHandler);
            mcpClient.setHandler((msg) => {
                const eventRecord = asRecord(msg) ?? { type: undefined };
                handleCodexEvent(eventRecord);
            });
        }

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
        this.happyServer = happyServer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        function logActiveHandles(tag: string) {
            if (!process.env.DEBUG) return;
            const anyProc: any = process as any;
            const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
            const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
            logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
            try {
                const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
                logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
            } catch {}
        }

        if (useAppServer && appServerClient) {
            await appServerClient.connect();
            await appServerClient.initialize({
                clientInfo: {
                    name: 'hapi-codex-client',
                    version: '1.0.0'
                }
            });
        } else if (useSdk && sdkClient) {
            await sdkClient.connect({
                sdkOptions: buildCodexSdkOptions({
                    mcpServers
                })
            });
        } else if (mcpClient) {
            await mcpClient.connect();
        }

        while (!this.shouldExit) {
            logActiveHandles('loop-top');
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                const waitSignal = this.abortController.signal;
                const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    if (waitSignal.aborted && !this.shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${this.shouldExit}`);
                    break;
                }
                message = batch;
            }

            if (!message) {
                break;
            }

            if (!useAppServer && wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                mcpClient?.clearSession();
                sdkClient?.clearThread();
                wasCreated = false;
                currentModeHash = null;
                pending = message;
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                session.onThinkingChange(false);
                continue;
            }

            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;

            try {
                if (!wasCreated) {
                    if (useAppServer && appServerClient) {
                        const threadParams = buildThreadStartParams({
                            mode: message.mode,
                            mcpServers,
                            cliOverrides: session.codexCliOverrides
                        });

                        const resumeCandidate = session.sessionId;
                        let threadId: string | null = null;

                        if (resumeCandidate) {
                            try {
                                const resumeResponse = await appServerClient.resumeThread({
                                    threadId: resumeCandidate,
                                    ...threadParams
                                }, {
                                    signal: this.abortController.signal
                                });
                                const resumeRecord = asRecord(resumeResponse);
                                const resumeThread = resumeRecord ? asRecord(resumeRecord.thread) : null;
                                threadId = asString(resumeThread?.id) ?? resumeCandidate;
                                logger.debug(`[Codex] Resumed app-server thread ${threadId}`);
                            } catch (error) {
                                logger.warn(`[Codex] Failed to resume app-server thread ${resumeCandidate}, starting new thread`, error);
                            }
                        }

                        if (!threadId) {
                            const threadResponse = await appServerClient.startThread(threadParams, {
                                signal: this.abortController.signal
                            });
                            const threadRecord = asRecord(threadResponse);
                            const thread = threadRecord ? asRecord(threadRecord.thread) : null;
                            threadId = asString(thread?.id);
                            if (!threadId) {
                                throw new Error('app-server thread/start did not return thread.id');
                            }
                        }

                        if (!threadId) {
                            throw new Error('app-server resume did not return thread.id');
                        }

                        this.currentThreadId = threadId;
                        session.onSessionFound(threadId);

                        const turnParams = buildTurnStartParams({
                            threadId,
                            message: message.message,
                            mode: message.mode,
                            cliOverrides: session.codexCliOverrides
                        });
                        startTurnTracking();
                        const turnResponse = await appServerClient.startTurn(turnParams, {
                            signal: this.abortController.signal
                        });
                        const turnRecord = asRecord(turnResponse);
                        const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                        const turnId = asString(turn?.id);
                        if (turnId) {
                            this.currentTurnId = turnId;
                        }
                    } else if (mcpClient) {
                        const startConfig: CodexSessionConfig = buildCodexStartConfig({
                            message: message.message,
                            mode: message.mode,
                            first,
                            mcpServers,
                            cliOverrides: session.codexCliOverrides
                        });

                        await mcpClient.startSession(startConfig, { signal: this.abortController.signal });
                        syncSessionId();
                    } else if (useSdk && sdkClient) {
                        const sdkOptions = buildCodexSdkOptions({
                            mcpServers
                        });
                        const sdkThreadOptions = buildCodexSdkThreadOptions({
                            mode: message.mode,
                            cwd: session.path,
                            cliOverrides: session.codexCliOverrides
                        });

                        const resumeCandidate = session.sessionId;
                        let threadId: string | null = null;

                        if (resumeCandidate) {
                            try {
                                const resumeResponse = await sdkClient.resumeThread({
                                    threadId: resumeCandidate,
                                    sdkOptions,
                                    threadOptions: sdkThreadOptions
                                });
                                threadId = asString(resumeResponse.thread.id) ?? resumeCandidate;
                                logger.debug(`[Codex] Resumed SDK thread ${threadId}`);
                            } catch (error) {
                                logger.warn(`[Codex] Failed to resume SDK thread ${resumeCandidate}, starting new thread`, error);
                            }
                        }

                        if (!threadId) {
                            const startResponse = await sdkClient.startThread({
                                sdkOptions,
                                threadOptions: sdkThreadOptions
                            });
                            threadId = asString(startResponse.thread.id);
                            if (threadId) {
                                logger.debug(`[Codex] Started SDK thread ${threadId}`);
                            } else {
                                logger.debug('[Codex] Started SDK thread (id will arrive via thread.started event)');
                            }
                        }

                        if (threadId) {
                            this.currentThreadId = threadId;
                            session.onSessionFound(threadId);
                        }

                        startTurnTracking();
                        const turnResponse = await sdkClient.startTurn({
                            input: [{ type: 'text', text: message.message }],
                            signal: this.abortController.signal
                        });
                        const turnRecord = asRecord(turnResponse);
                        const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                        const turnId = asString(turn?.id);
                        if (turnId) {
                            this.currentTurnId = turnId;
                        }
                    }

                    wasCreated = true;
                    first = false;
                } else if (useAppServer && appServerClient) {
                    if (!this.currentThreadId) {
                        logger.debug('[Codex] Missing thread id; restarting app-server thread');
                        wasCreated = false;
                        pending = message;
                        continue;
                    }

                    const turnParams = buildTurnStartParams({
                        threadId: this.currentThreadId,
                        message: message.message,
                        mode: message.mode,
                        cliOverrides: session.codexCliOverrides
                    });
                    startTurnTracking();
                    const turnResponse = await appServerClient.startTurn(turnParams, {
                        signal: this.abortController.signal
                    });
                    const turnRecord = asRecord(turnResponse);
                    const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                    const turnId = asString(turn?.id);
                    if (turnId) {
                        this.currentTurnId = turnId;
                    }
                } else if (useSdk && sdkClient) {
                    startTurnTracking();
                    const turnResponse = await sdkClient.startTurn({
                        input: [{ type: 'text', text: message.message }],
                        signal: this.abortController.signal
                    });
                    const turnRecord = asRecord(turnResponse);
                    const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                    const turnId = asString(turn?.id);
                    if (turnId) {
                        this.currentTurnId = turnId;
                    }
                } else if (mcpClient) {
                    await mcpClient.continueSession(message.message, { signal: this.abortController.signal });
                    syncSessionId();
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                if (useAsyncTurnClient) {
                    turnInFlight = false;
                    clearTurnWatchdog();
                }

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    if (!useAsyncTurnClient) {
                        wasCreated = false;
                        currentModeHash = null;
                        logger.debug('[Codex] Marked session as not created after abort for proper resume');
                    }
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    if (useAsyncTurnClient) {
                        this.currentThreadId = null;
                        sdkClient?.clearThread();
                        wasCreated = false;
                    }
                }
            } finally {
                if (!useAsyncTurnClient || !turnInFlight) {
                    clearTurnTracking('loop-finally');
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => session.queue.size(),
                        shouldExit: this.shouldExit,
                        sendReady
                    });
                }
                logActiveHandles('after-turn');
            }
        }
        clearTurnWatchdog();
    }

    protected async cleanup(): Promise<void> {
        logger.debug('[codex-remote]: cleanup start');
        try {
            if (this.appServerClient) {
                await this.appServerClient.disconnect();
            }
            if (this.sdkClient) {
                await this.sdkClient.disconnect();
            }
            if (this.mcpClient) {
                await this.mcpClient.disconnect();
            }
        } catch (error) {
            logger.debug('[codex-remote]: Error disconnecting client', error);
        }

        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }

        this.permissionHandler?.reset();
        this.reasoningProcessor?.abort();
        this.diffProcessor?.reset();
        this.permissionHandler = null;
        this.reasoningProcessor = null;
        this.diffProcessor = null;

        logger.debug('[codex-remote]: cleanup done');
    }
}

export async function codexRemoteLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const launcher = new CodexRemoteLauncher(session);
    return launcher.launch();
}
