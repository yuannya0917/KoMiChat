import { http, HttpResponse, delay } from 'msw'
import type { Conversation, ChatAttachment, ChatMessageModel } from '../features/chat/model/chatTypes'

const API_PREFIX = `${(import.meta.env.BASE_URL || '/').replace(/\/$/, '')}/api`

/**
 * 获取当前时间的 ISO 字符串。
 * - 用于 mock 数据的 `createdAt` 字段，保持格式统一、便于排序/展示。
 *
 * @returns 当前时间的 ISO 8601 字符串（UTC），例如 `2026-01-13T02:03:04.567Z`
 */
const nowIso = () => new Date().toISOString()

/**
 * 生成用于滚动/懒加载测试的消息列表。
 */
const buildSampleMessages = (conversationId: string, count: number): ChatMessageModel[] => {
    const base = Date.now() - count * 60_000
    return Array.from({ length: count }, (_, index) => {
        const role = index % 2 === 0 ? 'user' : 'assistant'
        return {
            id: `msg-${conversationId}-${index + 1}`,
            conversationId,
            text: role === 'user' ? `用户测试消息 ${index + 1}` : `AI 测试回复 ${index + 1}`,
            role,
            createdAt: new Date(base + index * 60_000).toISOString(),
        }
    })
}

/**
 * 缓存名称：用于在浏览器 Cache Storage 中持久化 mock 的对话/消息数据。
 * - 版本号变更可以用于“自然清空”旧缓存。
 */
const CACHE_NAME = 'komichat-mock-chat-cache-v2'

/**
 * 缓存 key：用一个固定的 Request 作为 cache 的索引。
 * - 这个 URL 不需要真的存在，只用于 cache.put/match。
 */
const CACHE_KEY = new Request('/__msw-cache/mock-chat')

const defaultStore: {
    conversations: Conversation[]
    messages: Record<string, ChatMessageModel[]>
} = {
    conversations: [
        { id: 'conv-1', title: '新对话 1', createdAt: nowIso() },
        { id: 'conv-2', title: '项目需求讨论', createdAt: nowIso() },
        { id: 'conv-3', title: '智能滚动测试', createdAt: nowIso() },
    ],
    messages: {
        'conv-1': [
            {
                id: 'msg-1',
                conversationId: 'conv-1',
                text: '项目仓库：https://github.com/yuannya0917/KoMiChat',
                role: 'assistant',
                createdAt: nowIso(),
            },
        ],
        'conv-2': [
            {
                id: 'msg-2',
                conversationId: 'conv-2',
                text: '我们需要整理一下新需求文档，方便评审。',
                role: 'user',
                createdAt: nowIso(),
            },
        ],
        'conv-3': buildSampleMessages('conv-3', 80),
    },
}

let store: typeof defaultStore = JSON.parse(JSON.stringify(defaultStore))
let storeLoaded = false

/**
 * 将当前 `store` 写入 Cache Storage 以便刷新后还能恢复。
 * - 失败时仅打印 warn，不阻塞主流程（mock 环境不应因为缓存失败而不可用）。
 *
 * @remarks
 * - 使用浏览器 `Cache Storage`（而非 localStorage），避免同步 API 阻塞主线程。
 * - 写入失败常见原因：非安全上下文、浏览器禁用/无痕策略、容量限制等。
 *
 * @returns Promise<void>
 */
const persistStore = async () => {
    try {
        const cache = await caches.open(CACHE_NAME)
        await cache.put(
            CACHE_KEY,
            new Response(JSON.stringify(store), {
                headers: { 'Content-Type': 'application/json' },
            })
        )
    } catch (error) {
        console.warn('persist mock store failed', error)
    }
}

/**
 * 从 Cache Storage 读取 `store`，并在结构不完整时回退到默认值。
 * - conversations：必须是数组，否则使用 `defaultStore.conversations`
 * - messages：以默认 messages 为底，再合并缓存中的 messages（避免缺 key）
 *
 * @remarks
 * - 读取/解析失败会回退到 `defaultStore`，确保 mock 不会“坏在缓存上”。
 *
 * @returns Promise<void>
 */
const loadStore = async () => {
    try {
        const cache = await caches.open(CACHE_NAME)
        const res = await cache.match(CACHE_KEY)
        if (!res) return
        const data = await res.json()
        store = {
            conversations: Array.isArray(data?.conversations) ? data.conversations : defaultStore.conversations,
            messages: { ...defaultStore.messages, ...(data?.messages || {}) },
        }
    } catch (error) {
        console.warn('load mock store failed, fallback to default', error)
        store = JSON.parse(JSON.stringify(defaultStore))
    }
}

/**
 * 确保 `store` 已经从缓存加载过（只会加载一次）。
 * - 每个 handler 的入口都会调用，避免首次请求读不到持久化数据。
 *
 * @returns Promise<void>
 */
const ensureStoreLoaded = async () => {
    if (storeLoaded) return
    await loadStore()
    storeLoaded = true
}

/**
 * 清洗/标准化附件对象，避免无效数据进入 store。
 * - 约定：没有 `uid` 的附件视为无效，返回 undefined
 *
 * @param att 可能不完整/来自外部请求的附件对象
 * @returns 标准化后的附件；若无 `uid` 则返回 undefined（表示该附件无效）
 */
const sanitizeAttachment = (att?: Partial<ChatAttachment>): ChatAttachment | undefined => {
    if (!att?.uid) return undefined
    return {
        uid: att.uid,
        name: att.name || '',
        size: att.size,
        type: att.type,
        url: att.url,
    }
}

type Scenario = 'error' | 'timeout' | 'unauthorized' | null

/**
 * 通过 URL query 参数解析“场景”，用于 mock 各类异常/超时。
 * - `?scenario=error`  -> 500
 * - `?scenario=timeout`-> 超时（长延迟）
 * - `?scenario=401`    -> 401
 *
 * @param url 请求 URL（字符串形式）
 * @returns 解析出的场景；解析失败或未命中则返回 null
 */
const getScenario = (url: string): Scenario => {
    try {
        const search = new URL(url).searchParams.get('scenario')
        if (search === 'error') return 'error'
        if (search === 'timeout') return 'timeout'
        if (search === '401') return 'unauthorized'
    } catch {
        // ignore parse errors
    }
    return null
}

/**
 * 根据场景做副作用模拟（目前仅模拟超时）。
 * - 与 `scenarioResponse` 配合：先 sleep，再决定是否返回错误响应。
 *
 * @param scenario 由 `getScenario` 解析得到的场景
 * @returns Promise<void>
 */
const maybeSimulate = async (scenario: Scenario) => {
    if (scenario === 'timeout') {
        // 模拟超时：长延迟
        await delay(6000)
    }
}

/**
 * 根据场景生成响应（用于模拟错误码）。
 * - 返回 null 表示“正常流程继续走”
 *
 * @param scenario 由 `getScenario` 解析得到的场景
 * @returns 若需要中断正常流程则返回对应的 `HttpResponse`；否则返回 null
 */
const scenarioResponse = (scenario: Scenario) => {
    if (scenario === 'error') {
        return HttpResponse.json({ message: 'Mocked 500' }, { status: 500 })
    }
    if (scenario === 'unauthorized') {
        return HttpResponse.json({ message: 'Mocked 401' }, { status: 401 })
    }
    return null
}

export const handlers = [
    /**
     * 获取会话列表。
     * - 支持通过 `?scenario=...` 模拟错误/超时
     *
     * @returns `Conversation[]`（JSON）
     */
    http.get(`${API_PREFIX}/conversations`, async ({ request }) => {
        await ensureStoreLoaded()
        const scenario = getScenario(request.url)
        await maybeSimulate(scenario)
        const resp = scenarioResponse(scenario)
        if (resp) return resp
        await delay(120)
        return HttpResponse.json(store.conversations)
    }),

    /**
     * 创建新会话。
     * - body: `{ title?: string }`
     * - 默认标题：`新对话 N`（N 基于当前会话数量）
     * - 会将新会话插入到列表头部，并初始化 messages 为空数组
     *
     * @returns `Conversation`（JSON，status 201）
     */
    http.post(`${API_PREFIX}/conversations`, async ({ request }) => {
        await ensureStoreLoaded()
        const scenario = getScenario(request.url)
        await maybeSimulate(scenario)
        const resp = scenarioResponse(scenario)
        if (resp) return resp
        await delay(120)
        const body = await request.json().catch(() => ({})) as { title?: string }
        const newConv: Conversation = {
            id: `conv-${Date.now()}`,
            title: body.title?.trim() || `新对话 ${store.conversations.length + 1}`,
            createdAt: nowIso(),
        }
        store.conversations = [newConv, ...store.conversations]
        store.messages[newConv.id] = []
        await persistStore()
        return HttpResponse.json(newConv, { status: 201 })
    }),

    /**
     * 删除会话及其消息。
     *
     * @param id 会话 id（path param）
     * @returns 204 无内容
     */
    http.delete(`${API_PREFIX}/conversations/:id`, async ({ params, request }) => {
        await ensureStoreLoaded()
        const scenario = getScenario(request.url)
        await maybeSimulate(scenario)
        const resp = scenarioResponse(scenario)
        if (resp) return resp
        await delay(80)
        const convId = params.id as string
        if (!convId) {
            return HttpResponse.json({ message: 'conversationId required' }, { status: 400 })
        }
        store.conversations = store.conversations.filter(c => c.id !== convId)
        delete store.messages[convId]
        await persistStore()
        return new HttpResponse(null, { status: 204 })
    }),

    /**
     * 重命名会话。
     *
     * @param id 会话 id（path param）
     * @returns 更新后的 `Conversation`
     */
    http.patch(`${API_PREFIX}/conversations/:id`, async ({ params, request }) => {
        await ensureStoreLoaded()
        const scenario = getScenario(request.url)
        await maybeSimulate(scenario)
        const resp = scenarioResponse(scenario)
        if (resp) return resp
        await delay(100)
        const convId = params.id as string
        if (!convId) {
            return HttpResponse.json({ message: 'conversationId required' }, { status: 400 })
        }
        const body = await request.json().catch(() => ({})) as { title?: string }
        const title = body.title?.trim()
        if (!title) {
            return HttpResponse.json({ message: 'title required' }, { status: 400 })
        }
        const conv = store.conversations.find(c => c.id === convId)
        if (!conv) {
            return HttpResponse.json({ message: 'not found' }, { status: 404 })
        }
        conv.title = title
        await persistStore()
        return HttpResponse.json(conv, { status: 200 })
    }),

    /**
     * 上传附件，返回带 url 的精简附件列表。
     * - body: FormData，包含多文件字段 `files` 以及元信息 `meta`（JSON 字符串）
     */
    http.post(`${API_PREFIX}/uploads`, async ({ request }) => {
        await ensureStoreLoaded()
        const formData = await request.formData().catch(() => null)
        if (!formData) {
            return HttpResponse.json({ message: 'invalid form data' }, { status: 400 })
        }

        const metaRaw = formData.get('meta')
        let meta: Array<{ uid: string; name?: string; size?: number; type?: string }> = []
        if (typeof metaRaw === 'string') {
            try {
                meta = JSON.parse(metaRaw)
            } catch {
                // ignore malformed meta, fallback to defaults
            }
        }

        const files = formData.getAll('files').filter((f): f is File => f instanceof File)
        if (!files.length) {
            return HttpResponse.json({ message: 'no files' }, { status: 400 })
        }

        const attachments: ChatAttachment[] = files.map((file, index) => {
            const info = meta[index]
            const uid = info?.uid || `upload-${Date.now()}-${index}`
            return {
                uid,
                name: info?.name || file.name,
                size: info?.size ?? file.size,
                type: info?.type ?? file.type,
                url: `/uploads/${encodeURIComponent(uid)}`,
            }
        })

        return HttpResponse.json({ attachments }, { status: 201 })
    }),

    /**
     * 获取指定会话的消息列表。
     * - 返回按 `createdAt` 升序排序后的列表（保证展示顺序稳定）
     *
     * @param id 会话 id（path param）
     * @returns `ChatMessageModel[]`（JSON）
     */
    http.get(`${API_PREFIX}/conversations/:id/messages`, async ({ params, request }) => {
        await ensureStoreLoaded()
        const scenario = getScenario(request.url)
        await maybeSimulate(scenario)
        const resp = scenarioResponse(scenario)
        if (resp) return resp
        await delay(100)
        const convId = params.id as string
        const list = store.messages[convId] || []
        return HttpResponse.json(
            [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        )
    }),

    /**
     * 向指定会话追加一条消息。
     * - body: `{ text?: string; attachments?: ChatAttachment[]; role?: 'user' | 'assistant' }`
     * - `text` 必填（trim 后不能为空）
     * - 若会话不存在：会自动创建会话壳（title 使用 `对话 ${convId}`）
     * - 附件会先经过 `sanitizeAttachment` 过滤无效项
     *
     * @param id 会话 id（path param）
     * @returns `ChatMessageModel`（JSON，status 201）
     */
    http.post(`${API_PREFIX}/conversations/:id/messages`, async ({ params, request }) => {
        await ensureStoreLoaded()
        const scenario = getScenario(request.url)
        await maybeSimulate(scenario)
        const resp = scenarioResponse(scenario)
        if (resp) return resp
        await delay(80)
        const convId = params.id as string
        if (!convId) {
            return HttpResponse.json({ message: 'conversationId required' }, { status: 400 })
        }
        const body = await request.json().catch(() => ({})) as {
            text?: string
            attachments?: ChatAttachment[]
            role?: 'user' | 'assistant'
        }
        const text = (body.text || '').trim()
        if (!text) {
            return HttpResponse.json({ message: 'text required' }, { status: 400 })
        }
        if (!store.messages[convId]) {
            store.messages[convId] = []
            if (!store.conversations.find(c => c.id === convId)) {
                store.conversations.unshift({
                    id: convId,
                    title: `对话 ${convId}`,
                    createdAt: nowIso(),
                })
            }
        }

        const message: ChatMessageModel = {
            id: `msg-${Date.now()}`,
            conversationId: convId,
            text,
            attachments: body.attachments
                ?.map(sanitizeAttachment)
                .filter((x): x is ChatAttachment => Boolean(x)),
            role: body.role ?? 'user',
            createdAt: nowIso(),
        }
        store.messages[convId].push(message)
        await persistStore()
        return HttpResponse.json(message, { status: 201 })
    }),
]
