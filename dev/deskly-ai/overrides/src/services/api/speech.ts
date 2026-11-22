/**
 * speech.ts — 语音接口（桥接版）
 *
 * 语音仍是 DeepSeek 专有能力：宿主会用当前服务商判断，非 DeepSeek 时返回 UNSUPPORTED。
 * 返回形态保持原样（PCM 字节流 / 转写文本），播放与录音逻辑无需改动。
 */

import { ApiError } from './client.js'
import { BridgeError, call } from './bridge.js'

export type TtsVoice = 'stella' | 'tide'

/** TTS 输出的裸 PCM 参数：24kHz、单声道、16-bit 小端 */
export const TTS_SAMPLE_RATE = 24000

const asApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ApiError('http', message)
}

/** 语音识别：audio 为 WAV（单声道 16-bit PCM）或 Ogg Opus。 */
export const transcribe = async (
  _apiKey: string,
  audio: Blob,
  _signal?: AbortSignal
): Promise<string> => {
  try {
    const result = await call<{ text: string }>('asr', { audio })
    return result.text
  } catch (error) {
    throw asApiError(error)
  }
}

/** 语音合成：宿主返回 PCM ArrayBuffer，这里包成流交给播放器。 */
export const synthesize = async (
  _apiKey: string,
  text: string,
  voice: TtsVoice,
  _signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  let buffer: ArrayBuffer
  try {
    const result = await call<ArrayBuffer>('tts', { text, voice })
    buffer = result instanceof ArrayBuffer ? result : new Uint8Array(result as ArrayLike<number>).buffer
  } catch (error) {
    throw asApiError(error)
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer))
      controller.close()
    },
  })
}

export { BridgeError }
