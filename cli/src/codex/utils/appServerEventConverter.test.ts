import { describe, expect, it, vi } from 'vitest';
import { AppServerEventConverter } from './appServerEventConverter';
import { logger } from '@/ui/logger';

describe('AppServerEventConverter', () => {
    it('maps thread/started', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('thread/started', { thread: { id: 'thread-1' } });

        expect(events).toEqual([{ type: 'thread_started', thread_id: 'thread-1' }]);
    });

    it('maps thread/resumed', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('thread/resumed', { thread: { id: 'thread-2' } });

        expect(events).toEqual([{ type: 'thread_started', thread_id: 'thread-2' }]);
    });

    it('maps turn/started and completed statuses', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('turn/started', { turn: { id: 'turn-1' } });
        expect(started).toEqual([{ type: 'task_started', turn_id: 'turn-1' }]);

        const completed = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Completed' });
        expect(completed).toEqual([{ type: 'task_complete', turn_id: 'turn-1' }]);

        const interrupted = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Interrupted' });
        expect(interrupted).toEqual([{ type: 'turn_aborted', turn_id: 'turn-1' }]);

        const failed = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Failed', message: 'boom' });
        expect(failed).toEqual([{ type: 'task_failed', turn_id: 'turn-1', error: 'boom' }]);
    });

    it('accumulates agent message deltas', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Hello' });
        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: ' world' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'msg-1', type: 'agentMessage' }
        });

        expect(completed).toEqual([{ type: 'agent_message', message: 'Hello world' }]);
    });

    it('maps command execution items and output deltas', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('item/started', {
            item: { id: 'cmd-1', type: 'commandExecution', command: 'ls' }
        });
        expect(started).toEqual([{
            type: 'exec_command_begin',
            call_id: 'cmd-1',
            command: 'ls'
        }]);

        converter.handleNotification('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'ok' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'cmd-1', type: 'commandExecution', exitCode: 0 }
        });

        expect(completed).toEqual([{
            type: 'exec_command_end',
            call_id: 'cmd-1',
            command: 'ls',
            output: 'ok',
            exit_code: 0
        }]);
    });

    it('maps reasoning deltas', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('item/reasoning/textDelta', { itemId: 'r1', delta: 'step' });
        expect(events).toEqual([{ type: 'agent_reasoning_delta', delta: 'step' }]);
    });

    it('maps diff updates', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('turn/diff/updated', { diff: 'diff --git a b' });
        expect(events).toEqual([{ type: 'turn_diff', unified_diff: 'diff --git a b' }]);
    });

    it('maps todo list updates from dedicated methods and item updates', () => {
        const converter = new AppServerEventConverter();

        const listEvents = converter.handleNotification('todo/list/updated', {
            items: [{ text: 'ship sdk', status: 'in_progress' }]
        });
        expect(listEvents).toEqual([{
            type: 'todo_list',
            items: [{ text: 'ship sdk', status: 'in_progress' }]
        }]);

        const itemEvents = converter.handleNotification('item/updated', {
            item: {
                id: 'todo-1',
                type: 'todo_list',
                items: [{ text: 'ship sdk', status: 'completed' }]
            }
        });
        expect(itemEvents).toEqual([{
            type: 'todo_list',
            items: [{ text: 'ship sdk', status: 'completed' }]
        }]);
    });

    it('unwraps codex/event/agent_message notifications', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/agent_message', {
            msg: { type: 'agent_message', message: 'hello from wrapper' }
        });

        expect(events).toEqual([{ type: 'agent_message', message: 'hello from wrapper' }]);
    });

    it('unwraps codex/event/task/started notifications', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/task/started', {
            msg: { turn_id: 'turn-42' }
        });

        expect(events).toEqual([{ type: 'task_started', turn_id: 'turn-42' }]);
    });

    it('unwraps codex/event/plan notifications into todo_list', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/plan', {
            msg: {
                entries: [{ content: 'verify pipeline', status: 'pending' }]
            }
        });

        expect(events).toEqual([{
            type: 'todo_list',
            entries: [{ content: 'verify pipeline', status: 'pending' }],
            items: [{ content: 'verify pipeline', status: 'pending' }]
        }]);
    });

    it('unwraps codex/event/error and codex/event/stream_error notifications', () => {
        const converter = new AppServerEventConverter();

        const errorEvents = converter.handleNotification('codex/event/error', {
            msg: {
                type: 'error',
                message: 'fatal',
                additional_details: { code: 'E_FATAL' }
            }
        });
        expect(errorEvents).toEqual([{
            type: 'error',
            message: 'fatal',
            additional_details: { code: 'E_FATAL' }
        }]);

        const streamEvents = converter.handleNotification('codex/event/stream_error', {
            msg: {
                type: 'stream_error',
                message: 'stream broke',
                additional_details: { phase: 'decode' }
            }
        });
        expect(streamEvents).toEqual([{
            type: 'stream_error',
            message: 'stream broke',
            additional_details: { phase: 'decode' }
        }]);
    });

    it('maps thread/status/changed systemError to visible error events', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('thread/status/changed', {
            thread: { id: 'thread-5' },
            turn: { id: 'turn-5' },
            status: {
                type: 'systemError',
                systemError: {
                    message: 'backend unavailable',
                    additional_details: { traceId: 'trace-1' }
                }
            }
        });

        expect(events).toEqual([{
            type: 'error',
            message: 'backend unavailable',
            thread_id: 'thread-5',
            turn_id: 'turn-5',
            additional_details: { traceId: 'trace-1' }
        }]);
    });

    it('unwraps codex/event/thread/status/changed systemError notifications', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/thread/status/changed', {
            msg: {
                thread: { id: 'thread-6' },
                status: {
                    type: 'systemError',
                    systemError: { message: 'wrapped system error', additional_details: { traceId: 'trace-wrapped' } }
                }
            }
        });

        expect(events).toEqual([{
            type: 'error',
            message: 'wrapped system error',
            thread_id: 'thread-6',
            additional_details: { traceId: 'trace-wrapped' }
        }]);
    });

    it('throttles unhandled notification logs per method', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        const converter = new AppServerEventConverter();

        try {
            converter.handleNotification('unknown/method', { attempt: 1 });
            converter.handleNotification('unknown/method', { attempt: 2 });
            converter.handleNotification('unknown/method', { attempt: 3 });
            expect(debugSpy).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(31_000);
            converter.handleNotification('unknown/method', { attempt: 4 });
            expect(debugSpy).toHaveBeenCalledTimes(2);
            expect(debugSpy.mock.calls[1]?.[0]).toContain('throttled');
            expect(debugSpy.mock.calls[1]?.[1]).toMatchObject({
                method: 'unknown/method',
                suppressed: 2
            });
        } finally {
            debugSpy.mockRestore();
            vi.useRealTimers();
        }
    });
});
