'use client'

const ChatHeader = () => (
  <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-5 sm:px-8">
    <div>
      <p className="font-dmmono text-[10px] uppercase tracking-[0.18em] text-muted">
        Workspace
      </p>
      <h1 className="mt-1 text-sm font-medium text-primary">
        Untitled conversation
      </h1>
    </div>
    <div className="flex items-center gap-2 text-xs text-muted">
      <span className="size-1.5 rounded-full bg-positive" />
      Ready
    </div>
  </header>
)

export default ChatHeader
