import { expect, test } from 'bun:test'
import type { MessageDTO } from '@ai-parter/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Composer } from '../../features/chat/Composer'
import { useExtensionsRuntime } from '../runtime'
import type { ClientExtensionAPI, SlotContribution } from '../types'
import activate from './imageGen'

test('独立图片按钮打开菜单，连续选择发出两个请求，群聊按成员展开，+ 菜单无重复分组', async () => {
  const requests: { path: string; body: unknown }[] = []
  const clicks = new Map<string, () => void>()
  let contribution: SlotContribution<'chat.composer.buttons'> | undefined
  const registered: string[] = []
  const infos: string[] = []
  const errors: string[] = []
  let synchronous = false
  let fail = false
  const qc = new QueryClient()
  // 保存扩展组件自己的状态以执行菜单事件；其余 Hook 和渲染仍使用真实 React。
  const states: unknown[] = []
  let cursor = 0
  const observedReact = {
    ...React,
    useState: ((initial: unknown) => {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [
        states[index],
        (value: unknown) => {
          states[index] = value
        },
      ]
    }) as typeof React.useState,
    createElement: ((type: unknown, props: Record<string, unknown> | null, ...children: React.ReactNode[]) => {
      const label = props?.['aria-label'] ?? children[0]
      if (type === 'button' && typeof label === 'string' && typeof props?.onClick === 'function')
        clicks.set(label, props.onClick as () => void)
      return React.createElement(type as React.ElementType, props, ...children)
    }) as typeof React.createElement,
  }
  let finish = () => {}
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const api = {
    React: observedReact,
    registerPage: () => {},
    on: () => () => {},
    queryClient: qc,
    getSettings: async () => ({ async: !synchronous }),
    toast: {
      info: (message: string) => {
        infos.push(message)
      },
      error: (message: string) => {
        errors.push(message)
      },
    },
    registerSlot: (name: string, value: unknown) => {
      registered.push(name)
      if (name === 'chat.composer.buttons') contribution = value as typeof contribution
    },
    fetchServer: async (path: string, init?: RequestInit) => {
      requests.push({ path, body: JSON.parse(String(init?.body)) })
      await gate
      if (fail) return Response.json({ error: { message: '模拟失败' } }, { status: 502 })
      return Response.json({ message: { id: 'generated' } })
    },
  } as unknown as ClientExtensionAPI
  const cleanup = activate(api)
  const render = () => {
    cursor = 0
    clicks.clear()
    return renderToStaticMarkup(contribution!.render({ chatId: 'chat' }))
  }
  try {
    expect(registered).not.toContain('chat.composer.menu')
    expect(render()).toContain('aria-label="生成图片"')
    clicks.get('生成图片')!()
    expect(render()).toContain('自由描述…')
    clicks.get('角色（全身）')!()
    expect(render()).not.toContain('自由描述…')
    clicks.get('生成图片')!()
    render()
    clicks.get('当前场景')!()
    await Bun.sleep(1)
    expect(requests).toEqual([
      { path: 'generate', body: { chatId: 'chat', mode: 'character' } },
      { path: 'generate', body: { chatId: 'chat', mode: 'scene' } },
    ])
    const busyButton = render()
    expect(busyButton).not.toContain('disabled')
    expect(busyButton).toContain('进行中的图片任务：2')
    finish()
    await Bun.sleep(1)
    qc.setQueryData(['chat', 'chat'], {
      pages: [
        {
          messages: [{ id: 'pending', meta: { imageGen: { status: 'pending' } } }],
          group: { members: [{ characterId: 'actor', name: '莱恩' }] },
        },
      ],
    })
    clicks.get('生成图片')!()
    const menu = render()
    expect(menu).toContain('画 莱恩（全身）')
    expect(menu).toContain('进行中的图片任务：1')
    clicks.get('画 莱恩（全身）')!()
    await Bun.sleep(1)
    expect(requests.at(-1)?.body).toEqual({ chatId: 'chat', mode: 'character', characterId: 'actor' })
    synchronous = true
    fail = true
    render()
    clicks.get('生成图片')!()
    render()
    clicks.get('当前场景')!()
    await Bun.sleep(1)
    expect(infos).toContain('正在生成：当前场景…')
    expect(errors).toEqual(['当前场景生成失败：模拟失败'])
    expect(render()).toContain('进行中的图片任务：1')
    states[0] = false
    const initial = useExtensionsRuntime.getInitialState()
    const previous = initial.slots
    initial.slots = [
      {
        slot: 'chat.composer.buttons',
        id: 'generate',
        extensionId: 'image-gen',
        order: 100,
        render: (props) => contribution!.render(props),
      },
    ]
    try {
      cursor = 0
      const composer = renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          <Composer chatId="chat" generating={true} group={null} lastMessage={null} />
        </QueryClientProvider>,
      )
      expect(composer).toContain('aria-label="生成图片"')
      expect(composer.match(/title="生成图片"/g)).toHaveLength(1)
    } finally {
      initial.slots = previous
    }
  } finally {
    finish()
    cleanup()
    qc.clear()
  }
})

test('编辑预览确认与取消、角色提示词保存、swipe 事件和草稿诊断', async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const clicks = new Map<string, () => void>()
  const fields = new Map<string, (event: { target: { value: string } }) => void>()
  const slots = new Map<string, SlotContribution<keyof import('../types').SlotProps>>()
  let swipe: ((event: import('../types').ClientEvent & { type: 'image:swipe-next' }) => void) | undefined
  const states: unknown[] = []
  let cursor = 0
  const qc = new QueryClient()
  const observed = {
    ...React,
    useState: ((initial: unknown) => {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [
        states[index],
        (value: unknown) => {
          states[index] = value
        },
      ]
    }) as typeof React.useState,
    createElement: ((type: unknown, props: Record<string, unknown> | null, ...children: React.ReactNode[]) => {
      const label = props?.['aria-label'] ?? children[0]
      if (type === 'button' && typeof label === 'string' && typeof props?.onClick === 'function')
        clicks.set(label, props.onClick as () => void)
      if (type === 'textarea' && typeof label === 'string' && typeof props?.onChange === 'function')
        fields.set(label, props.onChange as (event: { target: { value: string } }) => void)
      return React.createElement(type as React.ElementType, props, ...children)
    }) as typeof React.createElement,
  }
  let saves = 0
  let galleryRegistered = false
  const errors: string[] = []
  const client = {
    React: observed,
    queryClient: qc,
    getSettings: async () => ({ editBeforeGenerate: true }),
    saveSettings: async () => {
      saves++
    },
    toast: { info: () => {}, error: (message: string) => errors.push(message) },
    registerSlot: (name: string, value: SlotContribution<keyof import('../types').SlotProps>) => {
      slots.set(name, value)
    },
    registerPage: () => {
      galleryRegistered = true
    },
    on: (_type: string, handler: typeof swipe) => {
      swipe = handler
      return () => {
        swipe = undefined
      }
    },
    fetchServer: async (path: string, init?: RequestInit) => {
      requests.push({ path, body: JSON.parse(String(init?.body ?? '{}')) })
      if (path === 'prompt')
        return Response.json({
          snapshotId: 'preview',
          prompt: 'style, character, cat',
          negative: 'bad',
          width: 832,
          height: 1216,
          source: 'comfy',
          model: 'flux-dev',
          workflow: '角色头像图生图',
        })
      return Response.json({})
    },
  } as unknown as ClientExtensionAPI
  const cleanup = activate(client)
  function render(name: string, props: unknown) {
    cursor = 0
    clicks.clear()
    fields.clear()
    return renderToStaticMarkup(slots.get(name)!.render(props as never))
  }
  try {
    expect(galleryRegistered).toBe(true)
    render('chat.message.actions', { chatId: 'chat', message: { id: 'source' } })
    clicks.get('为这条消息生成图片')!()
    await Bun.sleep(1)
    const dialog = render('chat.composer.buttons', { chatId: 'chat' })
    expect(dialog).toContain('生成前编辑提示词')
    expect(dialog).toContain('模型：flux-dev')
    expect(dialog).toContain('832×1216')
    expect(dialog).toContain('角色头像图生图')
    expect(dialog).toContain('style, character, cat')
    expect(dialog).toContain('进行中的图片任务：1')
    expect(requests.map((item) => item.path)).toEqual(['prompt'])
    fields.get('正向提示词')!({ target: { value: 'edited positive' } })
    fields.get('负面提示词')!({ target: { value: 'edited negative' } })
    render('chat.composer.buttons', { chatId: 'chat' })
    clicks.get('开始生成')!()
    await Bun.sleep(1)
    expect(requests.at(-1)).toEqual({
      path: 'generate',
      body: {
        chatId: 'chat',
        mode: 'message',
        messageId: 'source',
        snapshotId: 'preview',
        prompt: 'edited positive',
        negative: 'edited negative',
      },
    })
    render('chat.message.actions', { chatId: 'chat', message: { id: 'cancel-source' } })
    clicks.get('为这条消息生成图片')!()
    await Bun.sleep(1)
    render('chat.composer.buttons', { chatId: 'chat' })
    clicks.get('取消')!()
    await Bun.sleep(1)
    expect(requests.filter((item) => item.path === 'generate')).toHaveLength(1)
    expect(render('chat.composer.buttons', { chatId: 'chat' })).not.toContain('生成前编辑提示词')
    states.length = 0
    const character = {
      id: 'actor',
      extensions: { other: { keep: true }, sd_character_prompt: { positive: 'old', negative: 'bad' } },
    }
    let saved: unknown
    const props = {
      character,
      save: async (patch: unknown) => {
        saved = patch
      },
    }
    render('character.editor.sections', props)
    fields.get('角色外貌提示词')!({ target: { value: 'blue hair, <lora:a:0.8>' } })
    fields.get('角色负面提示词')!({ target: { value: 'red hair' } })
    render('character.editor.sections', props)
    clicks.get('保存图片提示词')!()
    await Bun.sleep(1)
    expect(saved).toEqual({
      extensions: {
        other: { keep: true },
        sd_character_prompt: { positive: 'blue hair, <lora:a:0.8>', negative: 'red hair' },
      },
    })
    swipe!({
      type: 'image:swipe-next',
      chatId: 'chat',
      message: { id: 'image', meta: { imageGen: { status: 'done' } } } as MessageDTO,
    })
    await Bun.sleep(1)
    expect(requests.at(-1)).toEqual({ path: 'retry', body: { messageId: 'image', append: true } })
    const before = requests.length
    swipe!({
      type: 'image:swipe-next',
      chatId: 'chat',
      message: { id: 'image', meta: { imageGen: { status: 'pending' } } } as MessageDTO,
    })
    expect(requests).toHaveLength(before)
    states.length = 0
    const settings = { source: 'comfy', comfyUrl: 'http://draft', comfyCheckpoint: 'draft' }
    render('extensions.settings.footer', { settings })
    clicks.get('测试连接')!()
    await Bun.sleep(1)
    expect(requests.at(-1)).toEqual({ path: 'test-connection', body: { settings } })
    render('extensions.settings.footer', { settings })
    clicks.get('测试生成')!()
    await Bun.sleep(1)
    expect(requests.at(-1)).toEqual({ path: 'test', body: { settings } })
    expect(saves).toBe(0)
    expect(errors).toEqual([])
  } finally {
    cleanup()
    qc.clear()
  }
})
