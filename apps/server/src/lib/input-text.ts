/** 正文不做双向字符清洗，名称等身份字段才需要避免视觉冒充。 */
export function stripBidi(value: string) {
  return value.replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
}
