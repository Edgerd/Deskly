/**
 * bridge.ts — iframe 与 Deskly 宿主之间的 AI 通道
 *
 * 应用跑在 mods/deskly-ai/index.html 的 iframe 里，不直接碰网络：所有对话、附件、
 * 语音都经 postMessage 交给宿主脚本，由宿主在 mods/deskly-ai/ 下调用 Deskly.ai。
 * 这样密钥、服务商与高级参数始终只由系统设置一处提供。
 *
 * 消息形状固定为 request / reply / abort 三种，reply.kind 区分事件流、一次性结果与错误。
 */

/** 请求消息标记；宿主只在看到这个字段时才处理 */
export const BRIDGE_REQUEST = '__desklyAI:request'

type Reply = {
  __desklyAI: 'reply'
  id: number
  kind: 'event' | 'done' | 'result' | 'error'
  payload?: unknown
  code?: string
  message?: string
}

type Waiter = {
  onEvent?: (event: unknown) => void
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const waiters = new Map<number, Waiter>()
let sequence = 0

/** 宿主不可用（例如直接开 HTML 预览）时的统一错误 */
export class BridgeError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

const parentWindow = (): Window | null =>
  window.parent && window.parent !== window ? window.parent : null

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Reply | null
  if (!data || data.__desklyAI !== 'reply') return
  const waiter = waiters.get(data.id)
  if (!waiter) return
  if (data.kind === 'event') {
    waiter.onEvent?.(data.payload)
    return
  }
  waiters.delete(data.id)
  if (data.kind === 'error') {
    waiter.reject(new BridgeError(data.message || 'Deskly AI 请求失败', data.code))
    return
  }
  waiter.resolve(data.payload)
})

const post = (message: Record<string, unknown>, transfer: Transferable[] = []): boolean => {
  const target = parentWindow()
  if (!target) return false
  target.postMessage(message, '*', transfer)
  return true
}

/** 一次性调用：validate / upload / status / tts / asr。 */
export const call = <T = unknown>(method: string, payload?: unknown, transfer: Transferable[] = []) =>
  new Promise<T>((resolve, reject) => {
    const id = ++sequence
    if (!post({ __desklyAI: 'request', id, method, payload }, transfer)) {
      reject(new BridgeError('Deskly AI 未在与系统相连的窗口中运行'))
      return
    }
    waiters.set(id, { resolve: resolve as (value: unknown) => void, reject })
  })

export type StreamHandle = {
  events: AsyncGenerator<unknown>
  cancel: () => void
}

/** 流式调用：宿主逐条回推 Anthropic 事件，收到 message_stop 后结束。 */
export const openStream = (payload: unknown): StreamHandle => {
  const id = ++sequence
  const queue: unknown[] = []
  let finished = false
  let failure: Error | null = null
  let notify: (() => void) | null = null

  const wake = () => {
    const resume = notify
    notify = null
    resume?.()
  }

  waiters.set(id, {
    onEvent: (event) => {
      queue.push(event)
      wake()
    },
    resolve: () => {
      finished = true
      wake()
    },
    reject: (error) => {
      failure = error
      finished = true
      wake()
    },
  })

  if (!post({ __desklyAI: 'request', id, method: 'stream', payload })) {
    waiters.delete(id)
    failure = new BridgeError('Deskly AI 未在与系统相连的窗口中运行')
    finished = true
  }

  async function* events(): AsyncGenerator<unknown> {
    for (;;) {
      while (!queue.length && !finished) {
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
      if (queue.length) {
        yield queue.shift()
        continue
      }
      if (failure) throw failure
      return
    }
  }

  return {
    events: events(),
    cancel: () => {
      post({ __desklyAI: 'abort', id })
    },
  }
}
