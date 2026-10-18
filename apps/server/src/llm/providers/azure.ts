import { t } from '../../i18n'
import { type CompletionRequest, LlmError, type StreamChunk } from '../types'
import { openaiCompletion } from './openai'

export async function* azureCompletion(req: CompletionRequest): AsyncGenerator<StreamChunk> {
  const c = req.connection
  if (!c.options.deployment) throw new LlmError('CONFIG', t('Azure 连接缺少部署名'))
  const body = { ...req.body }
  delete body.model
  // 复用 OpenAI 的解析器，地址与鉴权由 Azure 显式提供。
  yield* openaiCompletion(
    { ...req, body, connection: c },
    {
      url: `${c.baseUrl.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(c.options.deployment)}/chat/completions?api-version=${encodeURIComponent(c.options.apiVersion || '2024-10-21')}`,
      headers: new Headers({ 'Content-Type': 'application/json', 'api-key': c.apiKey, ...c.headers }),
    },
  )
}
