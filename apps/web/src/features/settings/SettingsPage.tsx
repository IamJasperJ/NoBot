import { NumberField, Section, SelectField, SwitchField } from '../../components/form'
import { Button } from '../../components/ui'
import { SIDEBAR_MAX, SIDEBAR_MIN, useAppearance } from '../../stores/appearance'

/**
 * 设置页：外观和布局。改动立即生效，自动保存在这台设备的浏览器里。
 * 和聊天内容相关的配置在各自的页面（连接、生成预设、人设……）。
 */
export function SettingsPage() {
  const a = useAppearance()

  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-zinc-200 bg-white/90 px-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <h1 className="flex-1 font-semibold">设置</h1>
        <Button
          onClick={() => {
            if (confirm('恢复所有外观设置为默认值？')) a.reset()
          }}
        >
          恢复默认
        </Button>
      </header>

      <div className="space-y-4 p-3">
        <p className="text-sm text-zinc-500">外观设置只保存在当前浏览器里，手机和电脑可以分别设置。改动立即生效。</p>

        <Section title="外观">
          <SelectField
            label="主题"
            value={a.theme}
            onChange={(theme) => a.set({ theme })}
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
          <NumberField
            label="界面缩放"
            hint="整个界面的文字和间距大小（像素），默认 16"
            min={12}
            max={22}
            step={1}
            value={a.uiScale}
            onChange={(uiScale) => a.set({ uiScale })}
          />
        </Section>

        <Section title="对话区">
          <NumberField
            label="消息字号"
            hint="聊天消息正文的字号（像素），默认 15"
            min={12}
            max={28}
            step={1}
            value={a.messageFontSize}
            onChange={(messageFontSize) => a.set({ messageFontSize })}
          />
          <NumberField
            label="消息行距"
            hint="默认 1.7，数字越大行与行之间越松"
            min={1.2}
            max={2.4}
            step={0.1}
            value={a.messageLineHeight}
            onChange={(messageLineHeight) => a.set({ messageLineHeight })}
          />
          <SwitchField
            label="铺满宽度"
            hint="打开后对话区占满整个窗口宽度；关闭后按下面的最大宽度显示"
            checked={a.chatWidth === 0}
            onChange={(full) => a.set({ chatWidth: full ? 0 : 768 })}
          />
          {a.chatWidth > 0 && (
            <>
              <NumberField
                label="对话区最大宽度"
                hint="像素，默认 768。宽屏上可以调大，一行显示更多字"
                min={480}
                max={1600}
                step={16}
                value={a.chatWidth}
                onChange={(chatWidth) => a.set({ chatWidth })}
              />
              <SelectField
                label="对话区位置"
                value={a.chatAlign}
                onChange={(chatAlign) => a.set({ chatAlign })}
                options={[
                  { value: 'center', label: '居中' },
                  { value: 'left', label: '靠左（贴着侧栏）' },
                ]}
              />
            </>
          )}
          <SwitchField
            label="显示头像"
            hint="关闭后消息左边不显示头像，更紧凑"
            checked={a.showAvatars}
            onChange={(showAvatars) => a.set({ showAvatars })}
          />
        </Section>

        <Section title="侧栏">
          <NumberField
            label="侧栏宽度"
            hint={`左侧面板的宽度（像素），${SIDEBAR_MIN}–${SIDEBAR_MAX}。也可以直接拖动侧栏右边缘调整，双击边缘恢复默认`}
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            step={4}
            value={a.sidebarWidth}
            onChange={(sidebarWidth) => a.set({ sidebarWidth })}
          />
        </Section>
      </div>
    </div>
  )
}
