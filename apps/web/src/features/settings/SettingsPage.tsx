import { api } from '../../api/client'
import { NumberField, Section, SelectField, SwitchField } from '../../components/form'
import { ManagerLayout } from '../../components/layout'
import { Button } from '../../components/ui'
import { applyLanguage, t, useLanguage } from '../../i18n'
import { SIDEBAR_MAX, SIDEBAR_MIN, useAppearance } from '../../stores/appearance'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { AccountSection } from './AccountSection'
import { usePlayPresetPanel } from './PlayPresets'
import { useQuickReplyPanel } from './QuickReplies'

/**
 * 设置页：外观和布局。改动立即生效，自动保存在这台设备的浏览器里。
 * 和聊天内容相关的配置在各自的页面（连接、生成预设、人设……）。
 */
export function SettingsPage() {
  const a = useAppearance()
  const language = useLanguage((s) => s.language)
  const play = usePlayPresetPanel()
  const quick = useQuickReplyPanel()

  return (
    <ManagerLayout
      title={t('设置')}
      showDetailOnMobile={play.open || quick.open}
      detail={quick.open ? quick.detail : play.detail}
      actions={
        <Button
          size="sm"
          title={t('把外观设置恢复成默认值（不影响玩法预设）')}
          onClick={() => {
            if (confirm(t('恢复所有外观设置为默认值？'))) a.reset()
          }}
        >
          {t('恢复外观')}
        </Button>
      }
      list={
        <div className="space-y-2 px-1">
          <AccountSection />
          {play.list}
          {quick.list}
          <p className="px-1 pt-1 text-xs text-zinc-500">
            {t('下面的外观设置只保存在当前浏览器里，手机和电脑可以分别设置。改动立即生效。')}
          </p>

          <Section dense title={t('语言 / Language')}>
            <SelectField
              label={t('界面语言 / Language')}
              hint={t('界面文字的语言；没有对话上下文时（比如给背景起名），模型也用这个语言回答')}
              value={language}
              onChange={(value) => {
                const next = value === 'en' ? 'en' : 'zh'
                api
                  .updateAppSettings({ language: next })
                  .then(() => applyLanguage(next))
                  .catch((e) => toast.error(errorMessage(e)))
              }}
              options={[
                { value: 'zh', label: t('中文') },
                { value: 'en', label: 'English' },
              ]}
            />
          </Section>

          <Section dense title={t('外观')}>
            <SelectField
              label={t('主题')}
              value={a.theme}
              onChange={(theme) => a.set({ theme })}
              options={[
                { value: 'system', label: t('跟随系统') },
                { value: 'light', label: t('浅色') },
                { value: 'dark', label: t('深色') },
              ]}
            />
            <NumberField
              label={t('界面缩放')}
              hint={t('整个界面的文字和间距大小（像素），默认 16')}
              min={12}
              max={22}
              step={1}
              value={a.uiScale}
              onChange={(uiScale) => a.set({ uiScale })}
            />
          </Section>

          <Section dense title={t('对话区')}>
            <NumberField
              label={t('消息字号')}
              hint={t('聊天消息正文的字号（像素），默认 15')}
              min={12}
              max={28}
              step={1}
              value={a.messageFontSize}
              onChange={(messageFontSize) => a.set({ messageFontSize })}
            />
            <NumberField
              label={t('消息行距')}
              hint={t('默认 1.7，数字越大行与行之间越松')}
              min={1.2}
              max={2.4}
              step={0.1}
              value={a.messageLineHeight}
              onChange={(messageLineHeight) => a.set({ messageLineHeight })}
            />
            <SwitchField
              label={t('铺满宽度')}
              hint={t('打开后对话区占满整个窗口宽度；关闭后按下面的最大宽度显示')}
              checked={a.chatWidth === 0}
              onChange={(full) => a.set({ chatWidth: full ? 0 : 768 })}
            />
            {a.chatWidth > 0 && (
              <>
                <NumberField
                  label={t('对话区最大宽度')}
                  hint={t('像素，默认 768。宽屏上可以调大，一行显示更多字')}
                  min={480}
                  max={1600}
                  step={16}
                  value={a.chatWidth}
                  onChange={(chatWidth) => a.set({ chatWidth })}
                />
                <SelectField
                  label={t('对话区位置')}
                  value={a.chatAlign}
                  onChange={(chatAlign) => a.set({ chatAlign })}
                  options={[
                    { value: 'center', label: t('居中') },
                    { value: 'left', label: t('靠左（贴着侧栏）') },
                  ]}
                />
              </>
            )}
            <SwitchField
              label={t('显示头像')}
              hint={t('关闭后消息左边不显示头像，更紧凑')}
              checked={a.showAvatars}
              onChange={(showAvatars) => a.set({ showAvatars })}
            />
            <SwitchField
              label={t('自动隐藏左侧导航栏')}
              hint={t('宽屏下导航栏平时收起，鼠标移到窗口最左边时滑出；打开侧边面板时始终显示')}
              checked={a.autoHideNav}
              onChange={(autoHideNav) => a.set({ autoHideNav })}
            />
          </Section>

          <Section dense title={t('背景')}>
            <NumberField
              label={t('遮罩强度（%）')}
              hint={t('在背景图上盖一层半透明底色让文字更清楚；0 表示不加遮罩，原样显示背景')}
              min={0}
              max={90}
              step={1}
              value={a.bgDim}
              onChange={(bgDim) => a.set({ bgDim })}
            />
            <NumberField
              label={t('侧边栏不透明度（%）')}
              hint={t('有背景时侧边面板和编辑页的不透明度，调低能透出更多背景，调高文字更清楚')}
              min={20}
              max={100}
              step={1}
              value={a.panelOpacity}
              onChange={(panelOpacity) => a.set({ panelOpacity })}
            />
            <NumberField
              label={t('背景模糊（px）')}
              min={0}
              max={20}
              step={1}
              value={a.bgBlur}
              onChange={(bgBlur) => a.set({ bgBlur })}
            />
            <SelectField
              label={t('填充方式')}
              value={a.bgFit}
              onChange={(bgFit) => a.set({ bgFit })}
              options={[
                { value: 'cover', label: t('铺满裁剪') },
                { value: 'contain', label: t('完整显示') },
                { value: 'stretch', label: t('拉伸') },
                { value: 'center', label: t('居中原尺寸') },
              ]}
            />
            <SwitchField
              label={t('播放动态背景')}
              checked={a.bgAnimate}
              onChange={(bgAnimate) => a.set({ bgAnimate })}
            />
            <div className="flex min-h-9 items-center">
              <Button size="sm" onClick={() => useUi.getState().openView('backgrounds')}>
                {t('管理背景…')}
              </Button>
            </div>
          </Section>

          <Section dense title={t('侧栏')}>
            <NumberField
              label={t('侧栏宽度')}
              hint={t(
                '左侧面板的宽度（像素），{SIDEBAR_MIN}–{SIDEBAR_MAX}。也可以直接拖动侧栏右边缘调整，双击边缘恢复默认',
                { SIDEBAR_MIN, SIDEBAR_MAX },
              )}
              min={SIDEBAR_MIN}
              max={SIDEBAR_MAX}
              step={4}
              value={a.sidebarWidth}
              onChange={(sidebarWidth) => a.set({ sidebarWidth })}
            />
          </Section>
        </div>
      }
    />
  )
}
