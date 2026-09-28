'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'

const EXTERNAL_LINKS = {
  documentation: 'https://agno.link/agent-ui',
  agenOS: 'https://os.agno.com'
}

interface ActionButtonProps {
  href: string
  variant?: 'primary'
  text: string
}

const ActionButton = ({ href, variant, text }: ActionButtonProps) => {
  const baseStyles =
    'px-4 py-2 text-sm transition-colors font-dmmono tracking-tight'
  const variantStyles = {
    primary: 'border border-border hover:bg-neutral-800 rounded-xl'
  }

  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${baseStyles} ${variant ? variantStyles[variant] : ''}`}
    >
      {text}
    </Link>
  )
}

const ChatBlankState = () => {
  return (
    <section
      className="flex flex-col items-start text-left font-geist"
      aria-label="Welcome message"
    >
      <div className="flex max-w-2xl flex-col gap-y-7">
        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="text-3xl font-semibold leading-tight tracking-tight text-primary sm:text-5xl"
        >
          <span className="block">좋은 질문은</span>
          <span className="block text-brand">좋은 작업이 됩니다.</span>
        </motion.h1>
        <p className="max-w-lg text-base leading-7 text-muted">
          에이전트를 선택하고, 필요한 일을 자연스럽게 설명해 보세요. 대화의
          맥락은 이 작업실에 차곡차곡 쌓입니다.
        </p>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="flex flex-wrap gap-3"
        >
          <ActionButton
            href={EXTERNAL_LINKS.documentation}
            variant="primary"
            text="문서 살펴보기"
          />
          <ActionButton href={EXTERNAL_LINKS.agenOS} text="AgentOS 열기" />
        </motion.div>
      </div>
    </section>
  )
}

export default ChatBlankState
