import type { TelegramClient } from './telegram/client'

/** 兼容现有渠道服务的操作端口；平台参数翻译只在适配器内部进行。 */
export type ChannelClient = Pick<
  TelegramClient,
  'call' | 'serialized' | 'downloadFile' | 'fileDataHint' | 'draftSupported' | 'onDraftUnsupported'
>
