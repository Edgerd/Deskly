import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { call } from '../../services/api/bridge.js'
import styles from './Settings.module.css'

type AiStatus = {
  provider: string
  name: string
  model: string
  configured: boolean
}

/**
 * AI 状态来自宿主：服务商、模型与是否已配置密钥都由「Apple 智能与 Siri」决定。
 * 这里只读展示，不再提供应用内的密钥输入。
 */
const useAiStatus = () => {
  const [status, setStatus] = useState<AiStatus | null>(null)
  useEffect(() => {
    let alive = true
    void call<AiStatus>('status')
      .then((value) => {
        if (alive) setStatus(value)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return status
}

/** 保持原导出形状：设置弹窗仍按旧接口取 editor。 */
export const useApiKeyEditor = () => ({
  apiKey: 'managed-by-system' as string | null,
  editing: false,
  setEditing: (_editing: boolean) => undefined,
  form: {
    value: '',
    setValue: (_value: string) => undefined,
    submit: async () => undefined,
    verifying: false,
    error: null as string | null,
  },
  showInput: false,
})

type ApiKeyEditor = ReturnType<typeof useApiKeyEditor>

/** 系统统一管理密钥：显示当前服务商与模型，未配置时提示去哪里设置。 */
export const ApiKeyField = ({ editor: _editor }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  const status = useAiStatus()

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('systemManagedTitle')}</div>
        <div className={styles.apiKeySaved}>
          <span className={styles.apiKeyMask}>
            {status ? `${status.name} · ${status.model}` : t('systemManagedDesc')}
          </span>
        </div>
        {status && !status.configured ? <div className={styles.error}>{t('systemManagedDesc')}</div> : null}
      </div>
    </div>
  )
}

/** 移动端不再需要确认按钮。 */
export const ApiKeyConfirm = (_props: { editor: ApiKeyEditor }) => null
