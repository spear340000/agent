'use client'

import ChatInput from './ChatInput'
import MessageArea from './MessageArea'
import ChatHeader from './ChatHeader'
const ChatArea = () => {
  return (
    <main className="relative flex min-w-0 flex-grow flex-col overflow-hidden rounded-2xl border border-border bg-background/70 shadow-2xl shadow-black/10">
      <ChatHeader />
      <MessageArea />
      <div className="sticky bottom-0 px-4 pb-4 sm:px-8">
        <ChatInput />
      </div>
    </main>
  )
}

export default ChatArea
