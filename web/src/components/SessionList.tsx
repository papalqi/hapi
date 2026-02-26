import { useEffect, useMemo, useState } from 'react'
import type { SessionSummary, Machine } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useLongPress } from '@/hooks/useLongPress'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/lib/use-translation'

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
    machineNameOverrides: Map<string, string>,
    t: (key: string) => string
): string {
    const override = machineNameOverrides.get(machineId)
    if (override) return override
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

function groupSessionsByMachine(sessions: SessionSummary[], machines: Machine[], machineNameOverrides: Map<string, string>, t: (key: string) => string): MachineGroup[] {
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
            const machineName = getMachineDisplayName(machineId, machines, machineNameOverrides, t)

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

// 从 localStorage 读取/保存机器名覆盖
const MACHINE_NAMES_KEY = 'hapi-machine-name-overrides'

function loadMachineNameOverrides(): Map<string, string> {
    try {
        const raw = localStorage.getItem(MACHINE_NAMES_KEY)
        if (raw) {
            const obj = JSON.parse(raw) as Record<string, string>
            return new Map(Object.entries(obj))
        }
    } catch (error) {
        if (import.meta.env.DEV) {
            console.error('Failed to load machine name overrides:', error)
        }
    }
    return new Map()
}

function saveMachineNameOverrides(overrides: Map<string, string>) {
    try {
        const obj = Object.fromEntries(overrides)
        localStorage.setItem(MACHINE_NAMES_KEY, JSON.stringify(obj))
    } catch (error) {
        if (import.meta.env.DEV) {
            console.error('Failed to save machine name overrides:', error)
        }
    }
}

// --- 会话条目组件 ---

function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string) => void
    showPath?: boolean
    api: ApiClient | null
    selected?: boolean
}) {
    const { t } = useTranslation()
    const { session: s, onSelect, showPath = true, api, selected = false } = props
    const { haptic } = usePlatform()
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [renameOpen, setRenameOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)

    const { archiveSession, renameSession, deleteSession, isPending } = useSessionActions(
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
        onClick: () => {
            if (!menuOpen) {
                onSelect(s.id)
            }
        },
        threshold: 500
    })

    const sessionName = getSessionTitle(s)
    const statusDotClass = s.active
        ? (s.thinking ? 'bg-[#007AFF]' : 'bg-[var(--app-badge-success-text)]')
        : 'bg-[var(--app-hint)]'
    return (
        <>
            <button
                type="button"
                {...longPressHandlers}
                className={`session-list-item flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] select-none ${selected ? 'bg-[var(--app-secondary-bg)]' : ''}`}
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
                    <span>{t('session.item.modelMode')}: {s.modelMode || 'default'}</span>
                    {s.metadata?.worktree?.branch ? (
                        <span>{t('session.item.worktree')}: {s.metadata.worktree.branch}</span>
                    ) : null}
                </div>
            </button>

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionActive={s.active}
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
    onSave: (machineId: string, newName: string) => void
    onCancel: () => void
}) {
    const { t } = useTranslation()
    const [value, setValue] = useState(props.currentName)

    const handleSave = () => {
        const trimmed = value.trim()
        if (trimmed && trimmed !== props.currentName) {
            props.onSave(props.machineId, trimmed)
        } else {
            props.onCancel()
        }
    }

    return (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
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
            />
            <button
                type="button"
                onClick={handleSave}
                className="p-1 rounded hover:bg-[var(--app-subtle-bg)] text-[var(--app-badge-success-text)]"
                title={t('machine.save')}
            >
                <CheckIcon />
            </button>
            <button
                type="button"
                onClick={props.onCancel}
                className="p-1 rounded hover:bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                title={t('machine.cancel')}
            >
                <CloseIcon />
            </button>
        </div>
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
    const { renderHeader = true, api, selectedSessionId, machines = [] } = props

    // 机器名覆盖（可编辑的机器名，存在 localStorage 中）
    const [machineNameOverrides, setMachineNameOverrides] = useState<Map<string, string>>(
        () => loadMachineNameOverrides()
    )
    const [editingMachineId, setEditingMachineId] = useState<string | null>(null)

    const handleSaveMachineName = (machineId: string, newName: string) => {
        setMachineNameOverrides(prev => {
            const next = new Map(prev)
            next.set(machineId, newName)
            saveMachineNameOverrides(next)
            return next
        })
        setEditingMachineId(null)
    }

    // 按机器分一级分组，再按目录分二级分组
    const machineGroups = useMemo(
        () => groupSessionsByMachine(props.sessions, machines, machineNameOverrides, t),
        [props.sessions, machines, machineNameOverrides, t]
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

    const totalSessions = props.sessions.length
    const totalMachines = machineGroups.length

    return (
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

            <div className="flex flex-col">
                {machineGroups.map((machineGroup) => {
                    const machineCollapsed = isMachineCollapsed(machineGroup)
                    return (
                        <div key={machineGroup.machineId}>
                            {/* 一级分类：机器 */}
                            <button
                                type="button"
                                onClick={() => toggleMachine(machineGroup.machineId, machineCollapsed)}
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
                                            onSave={handleSaveMachineName}
                                            onCancel={() => setEditingMachineId(null)}
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
                                                    setEditingMachineId(machineGroup.machineId)
                                                }}
                                                className="p-0.5 rounded hover:bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] opacity-100 transition-opacity"
                                                title={t('machine.rename')}
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
                                                                onSelect={props.onSelect}
                                                                showPath={false}
                                                                api={api}
                                                                selected={s.id === selectedSessionId}
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
    )
}
