import { type Ability, type CheckResult, DND5E_SKILLS } from '@nobot/shared'
import { t } from '../../i18n'

/**
 * 跑团用到的名称翻译。shared 里的 DND5E_SKILLS / ABILITY_LABELS 是中文原文，
 * 这里每条都写成显式的 t 字面量调用，i18n 测试才能检查到英文是否齐全。
 */
export function skillLabel(id: string): string {
  switch (id) {
    case 'acrobatics':
      return t('杂技')
    case 'animal_handling':
      return t('驯兽')
    case 'arcana':
      return t('奥秘')
    case 'athletics':
      return t('运动')
    case 'deception':
      return t('欺瞒')
    case 'history':
      return t('历史')
    case 'insight':
      return t('洞悉')
    case 'intimidation':
      return t('威吓')
    case 'investigation':
      return t('调查')
    case 'medicine':
      return t('医药')
    case 'nature':
      return t('自然')
    case 'perception':
      return t('察觉')
    case 'performance':
      return t('表演')
    case 'persuasion':
      return t('游说')
    case 'religion':
      return t('宗教')
    case 'sleight_of_hand':
      return t('巧手')
    case 'stealth':
      return t('隐匿')
    case 'survival':
      return t('求生')
    default:
      return id
  }
}

export function abilityLabel(id: Ability | string): string {
  switch (id) {
    case 'str':
      return t('力量')
    case 'dex':
      return t('敏捷')
    case 'con':
      return t('体质')
    case 'int':
      return t('智力')
    case 'wis':
      return t('感知')
    case 'cha':
      return t('魅力')
    default:
      return id
  }
}

/** 检定名：技能显示技能名，属性检定显示属性名，豁免加「豁免」 */
export function checkLabel(check: Pick<CheckResult, 'skill' | 'kind' | 'ability'>): string {
  if (check.kind === 'save') return t('{ability}豁免', { ability: abilityLabel(check.ability) })
  if (check.kind === 'ability') return t('{ability}检定', { ability: abilityLabel(check.ability) })
  return skillLabel(check.skill)
}

/** 调整值的显示：+2 / −1 / +0 */
export function signed(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : `+${value}`
}

/** 选项里写的技能名：模型写英文 id / 英文名（Perception、sleight of hand）或中文名（察觉）时都翻成界面语言，其他原样显示 */
export function checkSkillLabel(skill: string): string {
  const raw = skill.trim()
  const id = raw.toLowerCase().replace(/\s+/g, '_')
  if (id in DND5E_SKILLS) return skillLabel(id)
  const zh = Object.entries(DND5E_SKILLS).find(([, info]) => info.label === raw)
  return zh ? skillLabel(zh[0]) : skill
}
