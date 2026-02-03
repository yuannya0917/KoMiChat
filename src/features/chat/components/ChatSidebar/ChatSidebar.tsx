import React from 'react'
import { Button } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import styles from './ChatSidebar.module.css'
import { ChatSidebarItem } from './ChatSidebarItem'
import type { Conversation } from '../../model/chatTypes'

interface ChatSidebarProps {
    conversations: Conversation[]
    activeConversationId: string
    onSelect: (id: string) => void
    onCreate: () => void
    onDelete: (id: string) => void
    onRename: (id: string, title: string) => void | Promise<void>
}

export const ChatSidebar: React.FC<ChatSidebarProps> = ({
    conversations,
    activeConversationId,
    onSelect,
    onCreate,
    onDelete,
    onRename,
}) => {
    return (
        <aside className={styles.sidebar}>
            <div className={styles.sidebarHeader}>
                <div className={styles.brand}>KoMiChat</div>
                <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    block
                    onClick={onCreate}
                >
                    新建对话
                </Button>
            </div>
            <div className={styles.conversationList}>
                {conversations.map((conv) => (
                    <ChatSidebarItem
                        key={conv.id}
                        conversation={conv}
                        isActive={conv.id === activeConversationId}
                        onSelect={onSelect}
                        onDelete={onDelete}
                        onRename={onRename}
                    />
                ))}
            </div>
        </aside>
    )
}

export default ChatSidebar
