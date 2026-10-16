import { Component, type ReactNode } from 'react'
import { Section } from '../components/form'
import { slotProps, useExtensionsRuntime } from './runtime'
import type { SlotName, SlotProps } from './types'

export class ExtensionBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <span className="text-xs text-red-500">扩展 {this.props.id} 出错</span>
    ) : (
      this.props.children
    )
  }
}

// 在子组件中调用 render，确保异常发生在边界内部。
function Render({ render }: { render: () => ReactNode }) {
  return render()
}

export function Slot<K extends SlotName>({ name, props }: { name: K; props: SlotProps[K] }) {
  const slots = useExtensionsRuntime((s) => s.slots)
  return slots
    .filter(
      (entry) =>
        entry.slot === name &&
        (name !== 'extensions.settings.footer' ||
          ('extensionId' in props && entry.extensionId === props.extensionId)) &&
        (name !== 'extensions.settings.field' ||
          ('fieldKey' in props && entry.extensionId === props.extensionId && entry.id === props.fieldKey)),
    )
    .sort((a, b) => a.order - b.order)
    .map((entry) => (
      <ExtensionBoundary key={`${entry.extensionId}:${entry.id}`} id={entry.extensionId}>
        {name === 'character.editor.sections' ? (
          <Section title={entry.title ?? entry.id} defaultOpen={false}>
            <Render render={() => entry.render(slotProps(props))} />
          </Section>
        ) : (
          <Render render={() => entry.render(slotProps(props))} />
        )}
      </ExtensionBoundary>
    ))
}

export function ExtensionPage({ view }: { view: string }) {
  const pages = useExtensionsRuntime((s) => s.pages)
  const page = pages.find((p) => `ext:${p.extensionId}:${p.id}` === view)
  return page ? (
    <div className="flex h-full min-w-0 flex-col">
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3">
        <ExtensionBoundary key={view} id={page.extensionId}>
          <Render render={page.render} />
        </ExtensionBoundary>
      </div>
    </div>
  ) : (
    <p className="p-6 text-sm text-zinc-500">扩展页面不存在或已停用</p>
  )
}
