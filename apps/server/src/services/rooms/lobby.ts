import { thumbFile } from '../../lib/files'
import { assetRoutes } from '../../routes/assets'
import { roomCover } from './dto'
import { asHost, charactersForRoom, unavailable, validInvite } from './index'

/** 邀请只允许读取大厅明确展示的封面和角色头像，不能借令牌浏览素材库。 */
export async function lobbyAsset(invite: string, kind: string, file: string, request: Request) {
  const { room } = validInvite(invite)
  const path = `/assets/${kind}/${file}`
  return asHost(room, async () => {
    const characterAvatar =
      kind === 'avatars' && charactersForRoom(room).some((c) => c.avatarFile && thumbFile(c.avatarFile) === file)
    if (!characterAvatar && roomCover(room.coverAsset)?.split('?')[0] !== `/api${path}`) throw unavailable()
    const response = await assetRoutes.fetch(new Request(`http://room/${kind}/${file}`, request))
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'private, no-store')
    return new Response(response.body, { status: response.status, headers })
  })
}
export function lobbyAssetUrl(invite: string, asset: string | null) {
  asset = roomCover(asset)
  if (!asset) return null
  const match = /^\/api\/assets\/(avatars|backgrounds)\/([^/?]+)(?:\?.*)?$/.exec(asset)
  return match ? `/api/rooms/lobby/assets/${match[1]}/${match[2]}?invite=${encodeURIComponent(invite)}` : null
}
