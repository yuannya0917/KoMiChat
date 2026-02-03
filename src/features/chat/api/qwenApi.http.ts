import type { ChatCompletionMessage } from '../model/chatTypes'

const AI_PROXY_URL =
  import.meta.env.VITE_QWEN_PROXY_URL || 'https://qwen-proxy.yspeaking.workers.dev'
const DEFAULT_QWEN_MODEL = import.meta.env.VITE_QWEN_MODEL || 'qwen-vl-plus'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_RETRY = 1
const DEFAULT_RETRY_DELAY_MS = 600

type StreamCallbacks = {
  onDelta?: (delta: string) => void
  onError?: (error: Error) => void
  onDone?: () => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isRetryableStatus = (status: number) =>
  status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504

const fetchWithTimeout = async (
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
) => {
  const controller = new AbortController()
  let timedOut = false

  if (init?.signal) {
    if (init.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    init.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (timedOut) {
      const err = new Error(`Request timeout after ${timeoutMs}ms`)
      ;(err as Error & { name?: string }).name = 'TimeoutError'
      throw err
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const fetchWithRetry = async (
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: { timeoutMs?: number; retry?: number; retryDelayMs?: number }
) => {
  const maxRetry = options?.retry ?? DEFAULT_RETRY
  const retryDelay = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  let attempt = 0

  while (true) {
    try {
      const res = await fetchWithTimeout(input, init, options?.timeoutMs)
      if (!isRetryableStatus(res.status) || attempt >= maxRetry) {
        return res
      }
    } catch (error) {
      const err = error as { name?: string }
      const retryable =
        err?.name === 'TimeoutError' ||
        (err?.name !== 'AbortError' && error instanceof TypeError)
      if (!retryable || attempt >= maxRetry) {
        throw error
      }
    }
    attempt += 1
    await sleep(retryDelay * Math.pow(2, attempt - 1))
  }
}

/**
 * 解析 SSE（text/event-stream）里的 data 段，提取增量文本。
 * - 兼容 OpenAI 风格：choices[0].delta.content
 * - 兼容非流式兜底：choices[0].message.content
 */
const extractDeltaText = (payload: any): string => {
  const choice = payload?.choices?.[0]
  const delta = choice?.delta?.content
  if (typeof delta === 'string') return delta

  const content = choice?.message?.content
  if (typeof content === 'string') return content

  return ''
}

export const generateAssistantReplyStream = async (
  messages: ChatCompletionMessage[],
  params?: {
    model?: string
    signal?: AbortSignal
  } & StreamCallbacks
): Promise<string> => {
  const model = params?.model || DEFAULT_QWEN_MODEL
  if (!AI_PROXY_URL) {
    throw new Error('缺少 Qwen 代理地址，请设置 VITE_QWEN_PROXY_URL')
  }

  const res = await fetchWithRetry(AI_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params?.signal,
    body: JSON.stringify({
      model,
      stream: true,
      messages,
    }),
  }, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retry: DEFAULT_RETRY,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AI 请求失败 ${res.status}: ${text || res.statusText}`)
  }

  if (!res.body) {
    throw new Error('AI 响应缺少可读流（res.body 为空）')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let acc = ''

  const emitDelta = (delta: string) => {
    if (!delta) return
    acc += delta
    params?.onDelta?.(delta)
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 事件以空行分隔：\n\n 或 \r\n\r\n
      // 这里做一个宽松切分：优先找 \n\n；如果上游是 \r\n，前面 decode 后也会包含 \r
      while (true) {
        const idx = buffer.indexOf('\n\n')
        const idxCr = buffer.indexOf('\r\n\r\n')
        const cut = idxCr !== -1 && (idx === -1 || idxCr < idx) ? idxCr : idx
        const sepLen = cut === idxCr ? 4 : 2
        if (cut === -1) break

        const chunk = buffer.slice(0, cut)
        buffer = buffer.slice(cut + sepLen)

        // 一个 SSE event 可能有多行 data:
        const lines = chunk.split(/\r?\n/)
        const dataLines = lines
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice('data:'.length).trimStart())
        if (dataLines.length === 0) continue
        const data = dataLines.join('\n')

        if (data === '[DONE]') {
          params?.onDone?.()
          return acc
        }

        try {
          const json = JSON.parse(data)
          const delta = extractDeltaText(json)
          emitDelta(delta)
        } catch (e) {
          // 非 JSON 的 data（或截断）不应致命：交给上层决定是否记录
          params?.onError?.(e as Error)
        }
      }
    }

    // 流正常结束但没有 [DONE]，也算完成
    params?.onDone?.()
    return acc
  } catch (error) {
    params?.onError?.(error as Error)
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

export const generateAssistantReply = async (
  messages: ChatCompletionMessage[],
  model = DEFAULT_QWEN_MODEL
): Promise<string> => {
  if (!AI_PROXY_URL) {
    throw new Error('缺少 Qwen 代理地址，请设置 VITE_QWEN_PROXY_URL')
  }

  const res = await fetchWithRetry(AI_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages,
    }),
  }, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retry: DEFAULT_RETRY,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AI 请求失败 ${res.status}: ${text || res.statusText}`)
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('AI 返回内容为空')
  return content
}

