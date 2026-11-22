import { create } from 'zustand'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'data'

/** 设置弹窗：侧边栏底部与错误提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/**
 * 密钥改由系统统一管理，应用内不再有「没有 API Key」的状态。
 * 保留导出，避免各处门禁改动；真正的未配置错误由统一接口的 NO_KEY 提示。
 */
export const ensureApiKey = () => true
