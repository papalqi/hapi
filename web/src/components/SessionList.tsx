import { useEffect, useMemo, useState, type SyntheticEvent } from 'react'
import type { SessionSummary, Machine } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useLongPress } from '@/hooks/useLongPress'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { MachineActionMenu } from '@/components/MachineActionMenu'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/lib/use-translation'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { clearMessageWindow } from '@/lib/message-window-store'

// --- 类型定义 ---

type SessionGroup = {
    directory: string
    displayName: string
    sessions: SessionSummary[]
    latestUpdatedAt: number
    hasActiveSession: boolean
}

type MachineGroup = {
    machineId: string
    machineName: string
    directoryGroups: SessionGroup[]
    latestUpdatedAt: number
    hasActiveSession: boolean
}

type SessionSelectInfo = {
    shiftKey: boolean
    metaKey: boolean
    ctrlKey: boolean
}

// --- 工具函数 ---

function getGroupDisplayName(directory: string): string {
    if (directory === 'Other') return directory
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    if (parts.length === 0) return directory
    if (parts.length === 1) return parts[0]
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

function getMachineDisplayName(
    machineId: string,
    machines: Machine[],
    t: (key: string) => string
): string {
    const machine = machines.find(m => m.id === machineId)
    if (machine?.metadata?.displayName) return machine.metadata.displayName
    if (machine?.metadata?.host) return machine.metadata.host
    if (machineId === 'unknown') return t('machine.unknown')
    return machineId.slice(0, 8)
}

function groupSessionsByDirectory(sessions: SessionSummary[]): SessionGroup[] {
    const groups = new Map<string, SessionSummary[]>()

    sessions.forEach(session => {
        const path = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
        if (!groups.has(path)) {
            groups.set(path, [])
        }
        groups.get(path)!.push(session)
    })

    return Array.from(groups.entries())
        .map(([directory, groupSessions]) => {
            const sortedSessions = [...groupSessions].sort((a, b) => {
                const rankA = a.active ? (a.pendingRequestsCount > 0 ? 0 : 1) : 2
                const rankB = b.active ? (b.pendingRequestsCount > 0 ? 0 : 1) : 2
                if (rankA !== rankB) return rankA - rankB
                return b.updatedAt - a.updatedAt
            })
            const latestUpdatedAt = groupSessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
                -Infinity
            )
            const hasActiveSession = groupSessions.some(s => s.active)
            const displayName = getGroupDisplayName(directory)

            return { directory, displayName, sessions: sortedSessions, latestUpdatedAt, hasActiveSession }
        })
        .sort((a, b) => {
            if (a.hasActiveSession !== b.hasActiveSession) {
                return a.hasActiveSession ? -1 : 1
            }
            return b.latestUpdatedAt - a.latestUpdatedAt
        })
}

function groupSessionsByMachine(sessions: SessionSummary[], machines: Machine[], t: (key: string) => string): MachineGroup[] {
    const machineMap = new Map<string, SessionSummary[]>()

    sessions.forEach(session => {
        const machineId = session.metadata?.machineId ?? 'unknown'
        if (!machineMap.has(machineId)) {
            machineMap.set(machineId, [])
        }
        machineMap.get(machineId)!.push(session)
    })

    return Array.from(machineMap.entries())
        .map(([machineId, machineSessions]) => {
            const directoryGroups = groupSessionsByDirectory(machineSessions)
            const latestUpdatedAt = machineSessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
                -Infinity
            )
            const hasActiveSession = machineSessions.some(s => s.active)
            const machineName = getMachineDisplayName(machineId, machines, t)

            return { machineId, machineName, directoryGroups, latestUpdatedAt, hasActiveSession }
        })
        .sort((a, b) => {
            if (a.hasActiveSession !== b.hasActiveSession) {
                return a.hasActiveSession ? -1 : 1
            }
            return b.latestUpdatedAt - a.latestUpdatedAt
        })
}

// --- 图标组件 ---

function PlusIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function BulbIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M12 2a7 7 0 0 0-4 12c.6.6 1 1.2 1 2h6c0-.8.4-1.4 1-2a7 7 0 0 0-4-12Z" />
        </svg>
    )
}

function ChevronIcon(props: { className?: string; collapsed?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`${props.className ?? ''} transition-transform duration-200 ${props.collapsed ? '' : 'rotate-90'}`}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function EditIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
    )
}

function ComputerIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
    )
}

function CheckIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    )
}

function CloseIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    )
}

// --- 辅助函数 ---

function getSessionTitle(session: SessionSummary): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

function getTodoProgress(session: SessionSummary): { completed: number; total: number } | null {
    if (!session.todoProgress) return null
    if (session.todoProgress.completed === session.todoProgress.total) return null
    return session.todoProgress
}

function getAgentLabel(session: SessionSummary): string {
    const flavor = session.metadata?.flavor?.trim()
    if (flavor) return flavor
    return 'unknown'
}

function formatRelativeTime(value: number, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    const delta = Date.now() - ms
    if (delta < 60_000) return t('session.time.justNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return t('session.time.minutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('session.time.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('session.time.daysAgo', { n: days })
    return new Date(ms).toLocaleDateString()
}

function resolveSelectionRange(orderedIds: string[], fromId: string, toId: string): string[] {
    const fromIndex = orderedIds.indexOf(fromId)
    const toIndex = orderedIds.indexOf(toId)
    if (fromIndex < 0 || toIndex < 0) {
        return [toId]
    }
    const start = Math.min(fromIndex, toIndex)
    const end = Math.max(fromIndex, toIndex)
    return orderedIds.slice(start, end + 1)
}

// --- 会话条目组件 ---

function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string, info?: SessionSelectInfo) => void
    showPath?: boolean
    api: ApiClient | null
    selected?: boolean
    multiSelected?: boolean
    selectionMode?: boolean
}) {
    const { t } = useTranslation()
    const {
        session: s,
        onSelect,
        showPath = true,
        api,
        selected = false,
        multiSelected = false,
        selectionMode = false
    } = props
    const { haptic } = usePlatform()
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [renameOpen, setRenameOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)

    const { archiveSession, recoverSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )

    const longPressHandlers = useLongPress({
        onLongPress: (point) => {
            haptic.impact('medium')
            setMenuAnchorPoint(point)
            setMenuOpen(true)
        },
        onClick: (info) => {
            if (!menuOpen) {
                onSelect(s.id, {
                    shiftKey: info.shiftKey,
                    metaKey: info.metaKey,
                    ctrlKey: info.ctrlKey
                })
            }
        },
        threshold: 500,
        disabled: selectionMode
    })

    const sessionName = getSessionTitle(s)
    const flavor = s.metadata?.flavor?.trim() ?? null
    const isCodexFamilyFlavor = flavor === 'codex' || flavor === 'gemini' || flavor === 'opencode'
    const modelLabelKey = isCodexFamilyFlavor ? 'session.item.model' : 'session.item.modelMode'
    const modelValue = isCodexFamilyFlavor ? (s.metadata?.model ?? 'auto') : (s.modelMode || 'default')
    const statusDotClass = s.active
        ? (s.thinking ? 'bg-[#007AFF]' : 'bg-[var(--app-badge-success-text)]')
        : 'bg-[var(--app-hint)]'
    const highlighted = selected || multiSelected
    const selectedClass = multiSelected
        ? 'bg-[var(--app-secondary-bg)] ring-1 ring-[var(--app-link)]/35'
        : highlighted
            ? 'bg-[var(--app-secondary-bg)]'
            : ''

    return (
        <>
            <button
                type="button"
                {...longPressHandlers}
                className={`session-list-item flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] select-none ${selectedClass}`}
                style={{ WebkitTouchCallout: 'none' }}
                aria-current={selected ? 'page' : undefined}
            >
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true">
                            <span
                                className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`}
                            />
                        </span>
                        <div className="truncate text-[13px] font-medium">
                            {sessionName}
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-[11px]">
                        {s.thinking ? (
                            <span className="text-[#007AFF] animate-pulse">
                                {t('session.item.thinking')}
                            </span>
                        ) : null}
                        {(() => {
                            const progress = getTodoProgress(s)
                            if (!progress) return null
                            return (
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <BulbIcon className="h-2.5 w-2.5" />
                                    {progress.completed}/{progress.total}
                                </span>
                            )
                        })()}
                        {s.pendingRequestsCount > 0 ? (
                            <span className="text-[var(--app-badge-warning-text)]">
                                {t('session.item.pending')} {s.pendingRequestsCount}
                            </span>
                        ) : null}
                        <span className="text-[var(--app-hint)]">
                            {formatRelativeTime(s.updatedAt, t)}
                        </span>
                    </div>
                </div>
                {showPath ? (
                    <div className="truncate text-[11px] text-[var(--app-hint)] pl-5.5">
                        {s.metadata?.path ?? s.id}
                    </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--app-hint)] pl-5.5">
                    <span className="inline-flex items-center gap-1.5">
                        <span className="flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true">
                            ❖
                        </span>
                        {getAgentLabel(s)}
                    </span>
                    <span>{t(modelLabelKey)}: {modelValue}</span>
                    {s.metadata?.worktree?.branch ? (
                        <span>{t('session.item.worktree')}: {s.metadata.worktree.branch}</span>
                    ) : null}
                </div>
            </button>

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionActive={s.active}
                onRecover={() => {
                    void recoverSession()
                }}
                onRename={() => setRenameOpen(true)}
                onArchive={() => setArchiveOpen(true)}
                onDelete={() => setDeleteOpen(true)}
                anchorPoint={menuAnchorPoint}
            />

            <RenameSessionDialog
                isOpen={renameOpen}
                onClose={() => setRenameOpen(false)}
                currentName={sessionName}
                onRename={renameSession}
                isPending={isPending}
            />

            <ConfirmDialog
                isOpen={archiveOpen}
                onClose={() => setArchiveOpen(false)}
                title={t('dialog.archive.title')}
                description={t('dialog.archive.description', { name: sessionName })}
                confirmLabel={t('dialog.archive.confirm')}
                confirmingLabel={t('dialog.archive.confirming')}
                onConfirm={archiveSession}
                isPending={isPending}
                destructive
            />

            <ConfirmDialog
                isOpen={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                title={t('dialog.delete.title')}
                description={t('dialog.delete.description', { name: sessionName })}
                confirmLabel={t('dialog.delete.confirm')}
                confirmingLabel={t('dialog.delete.confirming')}
                onConfirm={deleteSession}
                isPending={isPending}
                destructive
            />
        </>
    )
}

// --- 机器名编辑组件 ---

function MachineNameEditor(props: {
    machineId: string
    currentName: string
    onSave: (machineId: string, newName: string | null) => void
    onCancel: () => void
    isSaving?: boolean
}) {
    const { t } = useTranslation()
    const [value, setValue] = useState(props.currentName)

    const handleSave = () => {
        const trimmed = value.trim()
        const currentTrimmed = props.currentName.trim()
        if (trimmed === currentTrimmed) {
            props.onCancel()
            return
        }
        props.onSave(props.machineId, trimmed.length > 0 ? trimmed : null)
    }

    return (
        <div
            className="flex items-center gap-1.5"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
        >
            <input
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSave()
                    if (e.key === 'Escape') props.onCancel()
                }}
                className="bg-[var(--app-subtle-bg)] border border-[var(--app-divider)] rounded px-2 py-0.5 text-base font-semibold text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                autoFocus
                disabled={props.isSaving}
            />
            <button
                type="button"
                onClick={handleSave}
                className="p-1 rounded hover:bg-[var(--app-subtle-bg)] text-[var(--app-badge-success-text)]"
                title={t('machine.save')}
                disabled={props.isSaving}
            >
                <CheckIcon />
            </button>
            <button
                type="button"
                onClick={props.onCancel}
                className="p-1 rounded hover:bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                title={t('machine.cancel')}
                disabled={props.isSaving}
            >
                <CloseIcon />
            </button>
        </div>
    )
}

// --- 机器分组头部组件（支持长按菜单） ---

function MachineGroupHeader(props: {
    machineGroup: MachineGroup
    machineCollapsed: boolean
    machineOnline: boolean
    menuDisabled: boolean
    renameDisabled: boolean
    editingMachineId: string | null
    savingMachineId: string | null
    onToggleCollapse: () => void
    onStartRename: () => void
    onSaveMachineName: (machineId: string, newName: string | null) => void
    onCancelRename: () => void
    onOpenMenu: (point: { x: number; y: number }) => void
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const {
        machineGroup,
        machineCollapsed,
        machineOnline,
        menuDisabled,
        renameDisabled,
        editingMachineId,
        savingMachineId,
        onToggleCollapse,
        onStartRename,
        onSaveMachineName,
        onCancelRename,
        onOpenMenu
    } = props

    const stopPropagation = (e: SyntheticEvent) => {
        e.stopPropagation()
    }

    const longPressHandlers = useLongPress({
        onLongPress: (point) => {
            haptic.impact('medium')
            onOpenMenu(point)
        },
        onClick: onToggleCollapse,
        threshold: 500,
        disabled: menuDisabled
    })

    return (
        <button
            type="button"
            {...longPressHandlers}
            className="sticky top-0 z-20 flex w-full items-center gap-2 px-3 py-2.5 text-left bg-[var(--app-bg)] border-b border-[var(--app-divider)] transition-colors hover:bg-[var(--app-secondary-bg)]"
        >
            <ChevronIcon
                className="h-4 w-4 text-[var(--app-hint)]"
                collapsed={machineCollapsed}
            />
            <ComputerIcon className="h-4.5 w-4.5 text-[var(--app-link)]" />
            <div className="flex items-center gap-2 min-w-0 flex-1">
                {editingMachineId === machineGroup.machineId ? (
                    <MachineNameEditor
                        machineId={machineGroup.machineId}
                        currentName={machineGroup.machineName}
                        onSave={onSaveMachineName}
                        onCancel={onCancelRename}
                        isSaving={savingMachineId === machineGroup.machineId}
                    />
                ) : (
                    <>
                        <span className="font-semibold text-lg break-words" title={machineGroup.machineId}>
                            {machineGroup.machineName}
                        </span>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation()
                                if (renameDisabled) return
                                onStartRename()
                            }}
                            onMouseDown={stopPropagation}
                            onMouseUp={stopPropagation}
                            onTouchStart={stopPropagation}
                            onTouchEnd={stopPropagation}
                            onContextMenu={stopPropagation}
                            className="p-0.5 rounded hover:bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] opacity-100 transition-opacity"
                            title={machineOnline ? t('machine.rename') : t('machine.renameOnlineOnly')}
                            disabled={renameDisabled}
                        >
                            <EditIcon />
                        </button>
                        <span className="shrink-0 text-xs text-[var(--app-hint)]">
                            ({machineGroup.directoryGroups.reduce((sum, g) => sum + g.sessions.length, 0)})
                        </span>
                    </>
                )}
            </div>
        </button>
    )
}

// --- 主组件 ---

export function SessionList(props: {
    sessions: SessionSummary[]
    machines?: Machine[]
    onSelect: (sessionId: string) => void
    onNewSession: () => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
    api: ApiClient | null
    selectedSessionId?: string | null
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { renderHeader = true, api, selectedSessionId, machines = [] } = props

    const [editingMachineId, setEditingMachineId] = useState<string | null>(null)
    const [savingMachineId, setSavingMachineId] = useState<string | null>(null)

    // Session multi-select (shift/ctrl/cmd)
    const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set())
    const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)
    const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
    const [bulkDeletePending, setBulkDeletePending] = useState(false)

    // Machine long-press menu (update tools)
    const [machineMenuOpen, setMachineMenuOpen] = useState(false)
    const [machineMenuMachineId, setMachineMenuMachineId] = useState<string | null>(null)
    const [machineMenuAnchorPoint, setMachineMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [updateDialog, setUpdateDialog] = useState<{ machineId: string; tool: 'hapi' | 'codex' | 'claude' } | null>(null)
    const [updatePending, setUpdatePending] = useState(false)

    const handleSaveMachineName = (machineId: string, newName: string | null) => {
        if (!api) {
            setEditingMachineId(null)
            return
        }

        const machineOnline = machines.some((machine) => machine.id === machineId)
        if (!machineOnline) {
            window.alert(t('machine.renameOnlineOnly'))
            setEditingMachineId(null)
            return
        }

        setSavingMachineId(machineId)
        void api.renameMachine(machineId, newName)
            .then(() => {
                setEditingMachineId(null)
            })
            .catch((error) => {
                if (import.meta.env.DEV) {
                    console.error('Failed to rename machine:', error)
                }
                window.alert(t('machine.renameFailed'))
            })
            .finally(() => {
                setSavingMachineId(null)
            })
    }

    const openMachineMenu = (machineId: string, point: { x: number; y: number }) => {
        setMachineMenuMachineId(machineId)
        setMachineMenuAnchorPoint(point)
        setMachineMenuOpen(true)
    }

    const requestUpdate = (tool: 'hapi' | 'codex' | 'claude') => {
        if (!machineMenuMachineId) {
            return
        }
        setUpdateDialog({ machineId: machineMenuMachineId, tool })
    }

    const updateToolLabel = (tool: 'hapi' | 'codex' | 'claude'): string => {
        if (tool === 'hapi') return 'HAPI'
        if (tool === 'codex') return 'Codex'
        return 'Claude'
    }

    const runUpdate = async (): Promise<void> => {
        if (!api || !updateDialog) {
            return
        }

        const { machineId, tool } = updateDialog
        const machineOnline = machines.some((machine) => machine.id === machineId)
        if (!machineOnline) {
            throw new Error(t('machine.updateOnlineOnly'))
        }

        setUpdatePending(true)
        try {
            const result = await api.updateMachineTool(machineId, tool)
            if (!result.success) {
                throw new Error(result.error || t('machine.update.failed', { tool: updateToolLabel(tool) }))
            }

            window.alert(t('machine.update.success', { tool: updateToolLabel(tool) }))
        } finally {
            setUpdatePending(false)
        }
    }

    // 按机器分一级分组，再按目录分二级分组
    const machineGroups = useMemo(
        () => groupSessionsByMachine(props.sessions, machines, t),
        [props.sessions, machines, t]
    )

    const orderedSessionIds = useMemo(
        () => machineGroups.flatMap((machineGroup) =>
            machineGroup.directoryGroups.flatMap((dirGroup) =>
                dirGroup.sessions.map((session) => session.id)
            )
        ),
        [machineGroups]
    )

    // 折叠状态：分为机器级别和目录级别
    const [machineCollapseOverrides, setMachineCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const [dirCollapseOverrides, setDirCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )

    const isMachineCollapsed = (group: MachineGroup): boolean => {
        const override = machineCollapseOverrides.get(group.machineId)
        if (override !== undefined) return override
        return !group.hasActiveSession
    }

    const isDirCollapsed = (machineId: string, directory: string): boolean => {
        const key = `${machineId}::${directory}`
        const override = dirCollapseOverrides.get(key)
        if (override !== undefined) return override
        return false // 目录默认展开
    }

    const toggleMachine = (machineId: string, isCollapsed: boolean) => {
        setMachineCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(machineId, !isCollapsed)
            return next
        })
    }

    const toggleDir = (machineId: string, directory: string, isCollapsed: boolean) => {
        const key = `${machineId}::${directory}`
        setDirCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(key, !isCollapsed)
            return next
        })
    }

    // 清理过期的折叠状态
    useEffect(() => {
        const knownMachineIds = new Set(machineGroups.map(g => g.machineId))
        setMachineCollapseOverrides(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            let changed = false
            for (const key of next.keys()) {
                if (!knownMachineIds.has(key)) {
                    next.delete(key)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [machineGroups])

    useEffect(() => {
        const knownSessionIds = new Set(orderedSessionIds)
        setSelectedSessionIds((prev) => {
            if (prev.size === 0) return prev
            const next = new Set<string>()
            for (const id of prev) {
                if (knownSessionIds.has(id)) {
                    next.add(id)
                }
            }
            if (next.size === prev.size) return prev
            return next
        })
        setSelectionAnchorId((prev) => (prev && knownSessionIds.has(prev) ? prev : null))
    }, [orderedSessionIds])

    const totalSessions = props.sessions.length
    const totalMachines = machineGroups.length
    const selectedCount = selectedSessionIds.size
    const selectionMode = selectedCount > 0

    const clearSelection = () => {
        setSelectedSessionIds(new Set())
        setSelectionAnchorId(null)
    }

    const handleSessionSelect = (sessionId: string, info?: SessionSelectInfo) => {
        const hasShift = Boolean(info?.shiftKey)
        const hasToggle = Boolean(info?.metaKey || info?.ctrlKey)

        if (!hasShift && !hasToggle && !selectionMode) {
            props.onSelect(sessionId)
            setSelectionAnchorId(sessionId)
            return
        }

        setSelectedSessionIds((prev) => {
            const next = new Set(prev)

            if (hasShift) {
                const anchorId = selectionAnchorId ?? sessionId
                const rangeIds = resolveSelectionRange(orderedSessionIds, anchorId, sessionId)
                if (hasToggle) {
                    for (const id of rangeIds) {
                        next.add(id)
                    }
                    return next
                }
                return new Set(rangeIds)
            }

            if (hasToggle || selectionMode) {
                if (next.has(sessionId)) {
                    next.delete(sessionId)
                } else {
                    next.add(sessionId)
                }
                return next
            }

            return next
        })

        setSelectionAnchorId(sessionId)
    }

    const handleBulkDeleteConfirm = async () => {
        if (!api || selectedSessionIds.size === 0) {
            setBulkDeleteOpen(false)
            return
        }

        const deletingIds = Array.from(selectedSessionIds)
        setBulkDeletePending(true)
        try {
            await Promise.all(deletingIds.map((id) => api.deleteSession(id)))
            for (const id of deletingIds) {
                queryClient.removeQueries({ queryKey: queryKeys.session(id) })
                clearMessageWindow(id)
            }
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            clearSelection()
            setBulkDeleteOpen(false)
        } catch (error) {
            if (import.meta.env.DEV) {
                console.error('Failed to delete selected sessions:', error)
            }
            window.alert(t('dialog.error.default'))
        } finally {
            setBulkDeletePending(false)
        }
    }

    return (
        <>
            <div className="mx-auto w-full max-w-content flex flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-1">
                    <div className="text-xs text-[var(--app-hint)]">
                        {t('sessions.count', { n: totalSessions, m: totalMachines })}
                    </div>
                    <button
                        type="button"
                        onClick={props.onNewSession}
                        className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                        title={t('sessions.new')}
                    >
                        <PlusIcon className="h-5 w-5" />
                    </button>
                </div>
            ) : null}

            {selectionMode ? (
                <div className="sticky top-0 z-30 flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--app-divider)] bg-[var(--app-secondary-bg)]">
                    <div className="text-xs font-medium text-[var(--app-fg)]">
                        {t('sessions.selection.count', { n: selectedCount })}
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={clearSelection}
                            className="px-2 py-1 rounded text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                        >
                            {t('sessions.selection.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setBulkDeleteOpen(true)}
                            className="px-2 py-1 rounded text-xs text-[#E74C3C] hover:bg-[var(--app-subtle-bg)] transition-colors"
                        >
                            {t('sessions.selection.delete')}
                        </button>
                    </div>
                </div>
            ) : null}

            <div className="flex flex-col">
                {machineGroups.map((machineGroup) => {
                    const machineCollapsed = isMachineCollapsed(machineGroup)
                    const machineOnline = machines.some((machine) => machine.id === machineGroup.machineId)
                    const renameDisabled = !api || !machineOnline || savingMachineId === machineGroup.machineId
                    return (
                        <div key={machineGroup.machineId}>
                            {/* 一级分类：机器 */}
                            <MachineGroupHeader
                                machineGroup={machineGroup}
                                machineCollapsed={machineCollapsed}
                                machineOnline={machineOnline}
                                menuDisabled={!api || !machineOnline}
                                renameDisabled={renameDisabled}
                                editingMachineId={editingMachineId}
                                savingMachineId={savingMachineId}
                                onToggleCollapse={() => toggleMachine(machineGroup.machineId, machineCollapsed)}
                                onStartRename={() => setEditingMachineId(machineGroup.machineId)}
                                onSaveMachineName={handleSaveMachineName}
                                onCancelRename={() => setEditingMachineId(null)}
                                onOpenMenu={(point) => openMachineMenu(machineGroup.machineId, point)}
                            />

                            {/* 二级分类：目录 */}
                            {!machineCollapsed ? (
                                <div className="flex flex-col">
                                    {machineGroup.directoryGroups.map((dirGroup) => {
                                        const dirCollapsed = isDirCollapsed(machineGroup.machineId, dirGroup.directory)
                                        return (
                                            <div key={dirGroup.directory}>
                                                <button
                                                    type="button"
                                                    onClick={() => toggleDir(machineGroup.machineId, dirGroup.directory, dirCollapsed)}
                                                    className="sticky top-11 z-10 flex w-full items-center gap-2 pl-9 pr-3 py-1.5 text-left bg-[var(--app-bg)] border-b border-[var(--app-divider)] transition-colors hover:bg-[var(--app-secondary-bg)]"
                                                >
                                                    <ChevronIcon
                                                        className="h-3.5 w-3.5 text-[var(--app-hint)]"
                                                        collapsed={dirCollapsed}
                                                    />
                                                    <div className="flex items-center gap-2 min-w-0 flex-1">
                                                        <span className="font-medium text-sm break-words" title={dirGroup.directory}>
                                                            {dirGroup.displayName}
                                                        </span>
                                                        <span className="shrink-0 text-[11px] text-[var(--app-hint)]">
                                                            ({dirGroup.sessions.length})
                                                        </span>
                                                    </div>
                                                </button>
                                                {!dirCollapsed ? (
                                                    <div className="flex flex-col divide-y divide-[var(--app-divider)] border-b border-[var(--app-divider)] pl-6">
                                                        {dirGroup.sessions.map((s) => (
                                                            <SessionItem
                                                                key={s.id}
                                                                session={s}
                                                                onSelect={handleSessionSelect}
                                                                showPath={false}
                                                                api={api}
                                                                selected={s.id === selectedSessionId}
                                                                multiSelected={selectedSessionIds.has(s.id)}
                                                                selectionMode={selectionMode}
                                                            />
                                                        ))}
                                                    </div>
                                                ) : null}
                                            </div>
                                        )
                                    })}
                                </div>
                            ) : null}
                        </div>
                    )
                })}
            </div>
            </div>

            <MachineActionMenu
                isOpen={machineMenuOpen}
                onClose={() => setMachineMenuOpen(false)}
                onUpdateHapi={() => requestUpdate('hapi')}
                onUpdateCodex={() => requestUpdate('codex')}
                onUpdateClaude={() => requestUpdate('claude')}
                anchorPoint={machineMenuAnchorPoint}
            />

            <ConfirmDialog
                isOpen={updateDialog !== null}
                onClose={() => setUpdateDialog(null)}
                title={updateDialog
                    ? t('machine.update.title', { tool: updateToolLabel(updateDialog.tool) })
                    : ''}
                description={updateDialog
                    ? t('machine.update.description', {
                        tool: updateToolLabel(updateDialog.tool),
                        machine: getMachineDisplayName(updateDialog.machineId, machines, t)
                    })
                    : ''}
                confirmLabel={t('machine.update.confirm')}
                confirmingLabel={t('machine.update.confirming')}
                onConfirm={runUpdate}
                isPending={updatePending}
            />

            <ConfirmDialog
                isOpen={bulkDeleteOpen}
                onClose={() => setBulkDeleteOpen(false)}
                title={t('dialog.deleteMultiple.title')}
                description={t('dialog.deleteMultiple.description', { n: selectedCount })}
                confirmLabel={t('dialog.deleteMultiple.confirm')}
                confirmingLabel={t('dialog.deleteMultiple.confirming')}
                onConfirm={handleBulkDeleteConfirm}
                isPending={bulkDeletePending}
                destructive
            />
        </>
    )
}
