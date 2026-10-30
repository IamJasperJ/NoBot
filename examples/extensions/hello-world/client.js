// 浏览器直接执行 ES 模块，React 必须使用宿主提供的实例。
export default function activate(api) {
  const h = api.React.createElement
  async function stats() {
    const response = await api.fetchServer('/stats')
    if (!response.ok) throw new Error('读取消息统计失败')
    return response.json()
  }
  function showStats() {
    stats()
      .then((value) => api.toast.info(`已经保存 ${value.messages} 条消息`))
      .catch((e) => api.toast.error(e.message))
  }
  api.registerSlot('chat.header.actions', {
    id: 'stats',
    order: 50,
    render: () => h('button', { type: 'button', onClick: showStats }, '统计'),
  })
  api.registerSlot('chat.message.footer', {
    id: 'word-count',
    render: ({ message }) => h('small', { className: 'hello-word-count' }, `${Array.from(message.content).length} 字`),
  })
  api.registerSlot('chat.composer.menu', {
    id: 'greeting',
    render: ({ setText, close }) =>
      h(
        'button',
        {
          type: 'button',
          className: 'block w-full px-3 py-1.5 text-left',
          onClick: () => {
            api
              .getSettings()
              .then((settings) => {
                setText(String(settings.greeting ?? '你好，冒险者！'))
                close()
              })
              .catch((e) => api.toast.error(e.message))
          },
        },
        '插入问候语',
      ),
  })
  // 另外两个插槽也可注册；这里用复制和提示展示消息参数与侧栏位置。
  api.registerSlot('chat.message.actions', {
    id: 'count',
    render: ({ message }) =>
      h(
        'button',
        {
          type: 'button',
          className: 'block px-3 py-1.5',
          onClick: () => api.toast.info(`这条消息有 ${Array.from(message.content).length} 字`),
        },
        '查看字数',
      ),
  })
  api.registerSlot('sidebar.footer', {
    id: 'hello',
    render: () => h('small', { className: 'p-3' }, 'Hello 扩展已启用'),
  })
  function HelloPage() {
    const [value, setValue] = api.React.useState(null)
    api.React.useEffect(() => {
      let active = true
      stats()
        .then((data) => {
          if (active) setValue(data.messages)
        })
        .catch((e) => api.toast.error(e.message))
      return () => {
        active = false
      }
    }, [])
    return h(
      'div',
      { className: 'p-6' },
      h('h1', null, 'Hello'),
      h('p', null, value === null ? '读取统计中…' : `已经保存 ${value} 条消息`),
      h('button', { type: 'button', onClick: showStats }, '刷新统计提示'),
    )
  }
  api.registerPage({ id: 'hello', label: 'Hello', icon: '👋', render: () => h(HelloPage) })
  api.registerMessageTransform((text) => text.replaceAll('[[闪光]]', '✨'))
  // VN：舞台叠加层不拦点击，需要点击的元素自己加 pointer-events: auto；思考内容在 reasoning 里
  api.registerSlot('vn.stage.overlay', {
    id: 'speaker',
    render: ({ speaker, reasoning }) =>
      speaker || reasoning
        ? h(
            'div',
            { className: 'hello-vn-tag' },
            speaker ? `正在说话：${speaker}` : '',
            reasoning ? `（思考 ${Array.from(reasoning.text).length} 字）` : '',
          )
        : null,
  })
  api.registerSlot('vn.hud.items', {
    id: 'line',
    render: ({ beatIndex }) =>
      h('span', { className: 'vn-chip rounded-full px-3 py-1 text-xs' }, `第 ${(beatIndex ?? 0) + 1} 拍`),
  })
  const offs = [
    api.on('generation:complete', (event) => console.log('生成结束：', event.chatId)),
    api.on('vn:line', (event) => console.log('VN 台词：', event.speaker ?? '旁白', event.text)),
    api.on('vn:directive', (event) => console.log('VN 指令：', event.directive.op, event.directive)),
  ]
  // 宿主会移除所有注册项；额外的计时器、DOM 或全局监听器应由这里清理。
  return () => {
    for (const off of offs) off()
  }
}
