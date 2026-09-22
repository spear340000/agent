'use client'

import { useStore } from '@/store'
import Messages from './Messages'
import ScrollToBottom from '@/components/chat/ChatArea/ScrollToBottom'
import { StickToBottom } from 'use-stick-to-bottom'

const MessageArea = () => {
  const { messages } = useStore()

  return (
    <StickToBottom
      className="relative flex max-h-[calc(100vh-128px)] min-h-0 flex-grow flex-col"
      resize="smooth"
      initial="smooth"
    >
      <StickToBottom.Content className="flex min-h-full flex-col justify-center">
        <div className="mx-auto w-full max-w-3xl space-y-9 px-4 py-10 sm:px-8">
          <Messages messages={messages} />
        </div>
      </StickToBottom.Content>
      <ScrollToBottom />
    </StickToBottom>
  )
}

export default MessageArea
