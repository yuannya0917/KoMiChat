/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

interface Env {
	QWEN_API_KEY: string
}

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	// 如果前端需要读取自定义 header（如 request-id），可在这里补充
	'Access-Control-Expose-Headers': '*',
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS })
		}

		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS })
		}

		if (!env.QWEN_API_KEY) {
			return new Response('Missing QWEN_API_KEY', { status: 500, headers: CORS_HEADERS })
		}

		let body: any
		try {
			body = await request.json()
		} catch {
			return new Response('Bad Request', { status: 400, headers: CORS_HEADERS })
		}
		const isStream = Boolean(body?.stream)

		const upstream = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${env.QWEN_API_KEY}`,
			},
			// 下游（浏览器）断开时能及时取消上游请求，避免浪费 token/连接
			signal: request.signal,
			body: JSON.stringify({
				model: body?.model || 'qwen-turbo',
				stream: body?.stream ?? false,
				messages: body?.messages || [],
			}),
		})

		const headers = new Headers(upstream.headers)
		headers.set('Access-Control-Allow-Origin', CORS_HEADERS['Access-Control-Allow-Origin'])
		headers.set('Access-Control-Allow-Headers', CORS_HEADERS['Access-Control-Allow-Headers'])
		headers.set('Access-Control-Allow-Methods', CORS_HEADERS['Access-Control-Allow-Methods'])
		headers.set('Access-Control-Expose-Headers', CORS_HEADERS['Access-Control-Expose-Headers'])
		if (isStream) {
			// 强制 SSE 关键 header，避免代理/中间层缓冲导致“看起来不流式”
			headers.set('Content-Type', 'text/event-stream; charset=utf-8')
			headers.set('Cache-Control', 'no-cache, no-transform')
			headers.set('Connection', 'keep-alive')
			headers.set('X-Accel-Buffering', 'no')
		}

		return new Response(upstream.body, {
			status: upstream.status,
			headers,
		})
	},
} satisfies ExportedHandler<Env>;
