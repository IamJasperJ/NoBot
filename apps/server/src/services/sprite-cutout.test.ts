import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDTO, SpriteDTO, SpriteJobDTO } from '@nobot/shared'
import sharp from 'sharp'

test('重新抠图：原图、预览、任务锁、缓存版本及文件清理', async () => {
  if (!process.env.SPRITE_CUTOUT_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-cutout-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, SPRITE_CUTOUT_CHILD: '1', DATA_DIR: directory },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, out + err).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    return
  }
  const { paths } = await import('../env')
  paths.db = ':memory:'
  await (await import('../bootstrap')).bootstrap()
  const { app } = await import('../app')
  const { saveSprite, deleteSprite, listSprites, spriteOriginalPath, findSprite, deleteOutfit } = await import(
    './sprites'
  )
  const { mattingService } = await import('./matting')
  const request = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const character = (await (await request('/api/characters', { name: 'Cutout' })).json()) as CharacterDTO
  const base = `/api/characters/${character.id}/sprites`
  const original = await sharp({ create: { width: 32, height: 48, channels: 4, background: '#00ff00' } })
    .png()
    .toBuffer()
  const current = await sharp({ create: { width: 32, height: 48, channels: 4, background: '#000000' } })
    .webp()
    .toBuffer()
  const saved = await saveSprite(character.id, current, '', 'neutral', original)
  expect(saved.hasOriginal).toBe(true)
  const source = spriteOriginalPath(findSprite(character.id, saved.id))!
  expect(new Uint8Array(await Bun.file(source).arrayBuffer())).toEqual(new Uint8Array(original))
  const preview = await request(`${base}/${saved.id}/cutout/preview`, { mode: 'algorithm' })
  expect(preview.status).toBe(200)
  expect(preview.headers.get('Content-Type')).toBe('image/png')
  // 当前图全黑、原图绿幕，预览应去掉原图绿幕。
  expect(
    (
      await sharp(await preview.arrayBuffer())
        .ensureAlpha()
        .raw()
        .toBuffer()
    )[3],
  ).toBe(0)
  expect(listSprites(character.id)[0]).toEqual(saved)
  const previews = await Promise.all([
    request(`${base}/${saved.id}/cutout/preview`, { mode: 'algorithm' }),
    request(`${base}/${saved.id}/cutout/preview`, { mode: 'algorithm' }),
  ])
  expect(previews.map((response) => response.status)).toEqual([200, 200])
  expect(listSprites(character.id)[0]).toEqual(saved)
  for (const path of [`${base}/cutout`, `${base}/${saved.id}/cutout/preview`]) {
    expect((await request(path, { ids: [saved.id], mode: 'model' })).status).toBe(400)
    expect((await request(path, { ids: [saved.id], mode: 'native' })).status).toBe(400)
  }
  const legacy = await saveSprite(character.id, current, 'legacy', 'joy')
  const legacyBeforePreview = listSprites(character.id).find((sprite) => sprite.id === legacy.id)
  expect((await request(`${base}/${legacy.id}/cutout/preview`, { mode: 'algorithm' })).status).toBe(200)
  expect(listSprites(character.id).find((sprite) => sprite.id === legacy.id)).toEqual(legacyBeforePreview)
  expect(spriteOriginalPath(findSprite(character.id, legacy.id))).toBeUndefined()
  for (const ids of [[], new Array(501).fill(saved.id)])
    expect((await request(`${base}/cutout`, { ids, mode: 'algorithm' })).status).toBe(400)
  expect((await app.request(`${base}/cutout/missing`)).status).toBe(404)
  // 挂起推理以确定性验证同一角色的任务锁。
  const actual = mattingService.cutout
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: { force?: boolean }[] = []
  const cutout = spyOn(mattingService, 'cutout').mockImplementation(async (bytes, options, control) => {
    calls.push(control ?? {})
    await gate
    return actual(bytes, options, control)
  })
  let job: SpriteJobDTO & { jobId: string }
  try {
    const res = await request(`${base}/cutout`, { ids: [saved.id, legacy.id], mode: 'algorithm' })
    expect(res.status).toBe(200)
    job = (await res.json()) as typeof job
    expect((await request(`${base}/cutout`, { ids: [saved.id], mode: 'algorithm' })).status).toBe(409)
    release()
    for (let i = 0; i < 300; i++) {
      const state = (await (await app.request(`${base}/cutout/${job.jobId}`)).json()) as SpriteJobDTO
      if (state.status === 'done' || state.status === 'error') {
        expect(state).toMatchObject({ done: 2, failed: 0, status: 'done' })
        break
      }
      await Bun.sleep(10)
    }
    expect(calls.map((call) => call.force)).toEqual([false, true])
  } finally {
    release()
    cutout.mockRestore()
  }
  const updated = listSprites(character.id).find((sprite) => sprite.id === saved.id) as SpriteDTO
  expect(updated.updatedAt).toBeGreaterThan(saved.updatedAt)
  expect(updated.url).not.toBe(saved.url)
  expect(updated.thumbUrl).not.toBe(saved.thumbUrl)
  expect(updated.url).toContain('.png?v=')
  expect((await app.request(updated.url)).status).toBe(200)
  expect(await Bun.file(join(paths.sprites, character.id, `${saved.id}.webp`)).exists()).toBe(false)
  const legacySource = spriteOriginalPath(findSprite(character.id, legacy.id))!
  expect(new Uint8Array(await Bun.file(legacySource).arrayBuffer())).toEqual(new Uint8Array(current))
  const legacyPreview = await request(`${base}/${legacy.id}/cutout/preview`, { mode: 'algorithm' })
  expect(legacyPreview.status).toBe(200)
  expect(new Uint8Array(await Bun.file(legacySource).arrayBuffer())).toEqual(new Uint8Array(current))
  await deleteSprite(character.id, saved.id)
  expect(await Bun.file(source).exists()).toBe(false)
  await deleteOutfit(character.id, 'legacy')
  expect(await Bun.file(legacySource).exists()).toBe(false)
})
