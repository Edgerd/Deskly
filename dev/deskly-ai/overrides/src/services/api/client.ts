/**
 * client.ts — Deskly AI 的请求层（桥接版）
 *
 * 原版直接 fetch api.deepseek.com；本版本把请求交给宿主窗口，由 Deskly.ai 统一完成
 * 服务商选择、密钥管理与协议转换。对外导出的名字与错误类型保持不变，上层零改动。
 */

import { translate, type TranslationMessage } from '../../i18n/index.js'
import { BridgeError, call, openStream } from './bridge.js'
import type { CreateMessageRequest, FileObject, MessageStreamEvent } from './types.js'

/** 应用本身不再直连任何服务；保留导出供旧代码引用。 */
export const API_ORIGIN = ''

export type ApiErrorKind = 'http' | 'stream' | 'network' | 'interrupted' | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

/** 把桥接错误收敛成 ApiError，保留 code 供上层区分未配置密钥等情况。 */
const asApiError = (error: unknown, kind: ApiErrorKind = 'http'): ApiError => {
  if (error instanceof ApiError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ApiError(kind, message)
}

export const request = async (): Promise<Response> => {
  throw new ApiError('network', 'Deskly AI 不直接发起网络请求')
}

/** 连接测试：由宿主用当前服务商与密钥访问 /models。 */
export const verifyApiKey = async (_apiKey: string, _signal?: AbortSignal): Promise<void> => {
  try {
    await call('validate')
  } catch (error) {
    throw asApiError(error)
  }
}

/** 附件上传：DeepSeek 返回服务端 file_id，其他服务返回会话内句柄。 */
export const uploadFile = async (
  _apiKey: string,
  file: File,
  purpose: string | null,
  _signal?: AbortSignal
): Promise<FileObject> => {
  try {
    const result = await call<{ fileId: string; kind?: string }>('upload', { file, purpose })
    return { id: result.fileId, type: 'file', created_at: Date.now(), purpose } as unknown as FileObject
  } catch (error) {
    throw asApiError(error)
  }
}

/** 附件由桌面统一管理，删除对话时不再回删服务端文件。 */
export const deleteFile = async (_apiKey: string, _fileId: string): Promise<void> => {}

/**
 * 流式对话：请求体原样交给 Deskly.ai，宿主回推 Anthropic Messages 事件。
 * 中止时通知宿主 abort，并以 AbortError 结束生成器。
 */
export async function* streamMessage(
  _apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const handle = openStream({ body })
  let aborted = false
  const onAbort = () => {
    aborted = true
    handle.cancel()
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    for await (const event of handle.events) {
      if (aborted) throw new DOMException('Aborted', 'AbortError')
      const typed = event as MessageStreamEvent
      yield typed
      if (typed && typed.type === 'message_stop') return
    }
    if (aborted) throw new DOMException('Aborted', 'AbortError')
    throw new ApiError('interrupted', '')
  } catch (error) {
    if (aborted) throw new DOMException('Aborted', 'AbortError')
    if (error instanceof BridgeError || error instanceof Error) {
      throw asApiError(error)
    }
    throw new ApiError('interrupted', '')
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
