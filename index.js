/**
 * Agent言语引擎 · 插件（Host 侧，零依赖，无构建）
 *
 * 把「Agent言语令」从"开场手跑的脚本"升级为"常驻系统提示区块"：
 * 会话一开口就在场，不靠我记得去跑 python3 scripts/Agent言语引擎.py。
 *
 * 两块东西：
 *   1. 系统提示区块 ql:speech-gate —— 言语令正文（对主人说的话必须过的闸）。
 *   2. 工具 ql_speech_gate —— 把准备出口的文本喂进来，机械查三件：
 *      Agent词够不够、降智词有没有、称谓闸有没有踩「您」。
 *
 * 词表：默认用内置常用词表（从 scripts/Agent黑话对照表.md 真黑话层取）；配了
 * wordTable 就在加载时读磁盘正本，读不出（文件没了/格式变了）照旧用内置表。
 *
 * @module dsh-speech-gate
 */

import { fileURLToPath } from 'node:url'

export const name = 'ql-speech'

/** 依赖注入：没有 systemPrompt / tools 就不激活（不静默降级成半个插件）。 */
export const inject = ['systemPrompt', 'tools']

const SECTION_NAME = 'ql:speech-gate'

const DEFAULTS = Object.freeze({
  order: 60,
  tool: true,
  extraRules: '',
  wordTable: undefined,
  enabled: true,
})

/** 内置常用Agent词（真黑话层节选·20 枚）。正本在磁盘，可配 wordTable 覆盖。 */
const BUILTIN_WORDS = [
  '炼化', '炼活', '回炉', '踩坑入错题', '结丹', '坐忘', '出关', '开炉', '灵光', '守夜',
  '征战', '帝境', '出鞘', '归位', '搜魂', '温养', '蒙尘', '守土', '披挂', '镇守',
]

/** 降智词 → Agent词（冒号左边落进对主人的话就换掉）。 */
const BLACKLIST = new Map([
  ['落盘', '炼化'],
  ['对账', '核账'],
  ['闭环', '结丹'],
  ['口径', '说法'],
  ['收口', '收兵'],
  ['收官', '封卷'],
  ['沉淀', '温养'],
  ['兜底', '接住'],
  ['回执', '凭据'],
  ['根因', '病根'],
  ['探针', '哨兵'],
  ['基线', '底子'],
  ['门禁', '关卡'],
  ['夹具', '架子'],
  ['快照', '存影'],
  ['痛点', '疼处'],
  ['验活', '炼活'],
  ['吃灰', '蒙尘'],
  ['钉死', '焊死'],
])

/** 称谓闸：禁侍奉腔「您」，首选用称「主公」。 */
const HONORIFIC_BANNED = '您'

function normalizeConfig(config) {
  const raw = config ?? {}
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('ql-speech: config.enabled must be a boolean')
  }
  if (raw.tool !== undefined && typeof raw.tool !== 'boolean') {
    throw new Error('ql-speech: config.tool must be a boolean')
  }
  if (raw.order !== undefined && (typeof raw.order !== 'number' || !Number.isFinite(raw.order))) {
    throw new Error('ql-speech: config.order must be a finite number')
  }
  if (raw.extraRules !== undefined && typeof raw.extraRules !== 'string') {
    throw new Error('ql-speech: config.extraRules must be a string')
  }
  if (raw.wordTable !== undefined && (typeof raw.wordTable !== 'string' || raw.wordTable.trim() === '')) {
    throw new Error('ql-speech: config.wordTable must be a non-empty path string')
  }
  return {
    order: raw.order ?? DEFAULTS.order,
    tool: raw.tool ?? DEFAULTS.tool,
    extraRules: (raw.extraRules ?? DEFAULTS.extraRules).trim(),
    wordTable: raw.wordTable === undefined ? DEFAULTS.wordTable : raw.wordTable.trim(),
    enabled: raw.enabled ?? DEFAULTS.enabled,
  }
}

/** 从对照表正文抽加粗词：现行格式（## 方言对照表）与旧分卷格式（### ①真黑话层）都认。 */
function parseTable(text) {
  const section = text.includes('## 方言对照表')
    ? (text.split('## 方言对照表')[1] ?? '').split('## 使用规约')[0]
    : (text.split('### ①真黑话层')[1] ?? '').split('### ②通语层')[0]
  if (section === undefined || section === '') return []
  const found = [...section.matchAll(/\*\*([^*]+)\*\*/g)]
    .map(match => match[1].trim())
    .filter(word => word.length >= 2 && word.length <= 6 && !word.startsWith('Agent'))
  return [...new Set(found)]
}

/** 候选词表路径：显式配置优先，其次插件包同级的 scripts/ 正本。 */
function wordTableCandidates(wordTable) {
  const candidates = []
  if (wordTable !== undefined) candidates.push(wordTable)
  try {
    candidates.push(fileURLToPath(new URL('../scripts/Agent黑话对照表.md', import.meta.url)))
  } catch {
    /* 非文件装法（打包/嵌入）拿不到相对路径，走后备 */
  }
  return candidates
}

/**
 * 按候选路径逐个试读词表正本；全部失败就用内置表。
 * 只读一次、失败不抛：词表坏了也得能开口。
 */
async function loadWords(candidates) {
  const { readFile } = await import('node:fs/promises')
  for (const path of candidates) {
    try {
      const words = parseTable(await readFile(path, 'utf8'))
      if (words.length >= 10) return { words, source: path }
    } catch {
      /* 换下一个候选 */
    }
  }
  return { words: [...BUILTIN_WORDS], source: '内置兜底' }
}

function renderSection(words, cfg) {
  const wordList = words.slice(0, 20).join('、')
  const swap = [...BLACKLIST].map(([bad, good]) => `${bad}→${good}`).join('、')
  const lines = [
    '## Agent言语令 · 常驻闸（插件挂载，不靠我记得）',
    '',
    '**谁在说话**：Agent（万古诸天剑）对主人说话。称「主人」或「主公」，用「你」；'
      + '禁「' + HONORIFIC_BANNED + '」（侍奉腔＝器面失格），禁「用户」「客户」这类把主人推远的称谓。',
    '',
    '**一、Agent词**：对主人说的每一轮至少落两枚真黑话层Agent词。'
      + '词表正本在磁盘 scripts/Agent黑话对照表.md（四十枚），插件内置常用词兜底：' + wordList + '。'
      + 'Agent词首次出现须配一句白话（"炼化＝把结果写进磁盘"），白话里可以用通语——那是翻译，不是回魂。',
    '',
    '**二、降智词**：下列词落进对主人的对话即拦截，出口前换成Agent词：' + swap + '。'
      + '（代码、路径、引用原文不受此限——这条管对主人说的话，不管工件。）',
    '',
    '**三、修仙腔**：启禀／谨遵／此物有诈三档，按场面选强度；日常轻用，重大战报必带一句。'
      + '腔是骨头不是皮：腔要撑住判断，不许拿腔掩空。',
    '',
    '**四、中文**：思考轨迹与工具命令的描述一律中文，英文只留代码、命令、路径、专名。'
      + '技术越深越要翻成人话——翻不出＝我自己没懂（费曼判据）。',
    '',
    '**五、出口三闸**（只对长输出，超过 120 字才算；短答、闲聊、单句问答豁免，禁为过闸灌水）：',
    '①数字闸——至少一个读数、复现命令或实测，禁形容词空转；',
    '②人话闸——术语首现配白话，收尾一句"这意味着什么／对你有什么影响"；',
    '③回执闸——交了什么、在哪、怎么验，三件说全。',
    '',
  ]
  if (cfg.extraRules !== '') lines.push(cfg.extraRules, '')
  lines.push('**违令＝回魂**：主人抓一次，我自己记入issue log，不辩解。')
  return lines.join('\n')
}

/** 过闸：返回人读的报告。 */
function inspect(text, words) {
  const trimmed = text.trim()
  const hits = words.filter(word => trimmed.includes(word))
  const banned = [...BLACKLIST.keys()].filter(word => trimmed.includes(word))
  const honorific = trimmed.includes(HONORIFIC_BANNED)
  const long = trimmed.length > 120

  const verdict = banned.length > 0 || honorific
    ? '拦截'
    : (long && hits.length < 2 ? '黄标' : 'PASS')

  const lines = [
    `过闸判定：${verdict}`,
    `字数：${trimmed.length}${long ? '（长输出·三闸全开）' : '（短输出·Agent词数量豁免）'}`,
    `Agent词：${hits.length} 枚${hits.length > 0 ? '（' + hits.join('、') + '）' : ''}——`
      + (long ? '对主人说话需 ≥2 枚' : '短输出豁免数量要求'),
  ]
  if (banned.length > 0) {
    lines.push(`降智词命中 ${banned.length} 处：` + banned.map(word => `${word}→${BLACKLIST.get(word)}`).join('、'))
  } else {
    lines.push('降智词：干净')
  }
  lines.push(honorific ? '称谓闸：踩了「您」——改成「你」或「主公」' : '称谓闸：干净')
  if (verdict !== 'PASS') {
    lines.push('', '改法：先把命中的降智词换成右边那枚Agent词，补足Agent词，再出口。')
  }
  return lines.join('\n')
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('ql-speech：主开关关着，未挂载')
    return
  }

  let words = [...BUILTIN_WORDS]

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: cfg.order,
    text: () => renderSection(words, cfg),
  }), 'ql-speech.section()')

  if (cfg.tool) {
    ctx.effect(() => ctx.tools.register({
      name: 'ql_speech_gate',
      description: 'Agent言语闸：把一段准备对主人出口的文本喂进来，机械检查Agent词够不够、'
        + '降智词有没有、称谓闸有没有踩「您」，返回 PASS／黄标／拦截 与逐项读数；'
        + '不带 text 则返回当前挂载的令文与词表（用于核对插件是否在场）。',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要过闸的文本；省略则返回令文与词表。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { report: { type: 'string' } },
          required: ['report'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      execute: async (args) => {
        const text = args !== null && typeof args === 'object' && typeof args.text === 'string'
          ? args.text
          : undefined
        if (text === undefined) {
          return {
            report: [
              `令文已挂载：区块名 ${SECTION_NAME}，排序 ${cfg.order}，Agent词 ${words.length} 枚（内置兜底 ${BUILTIN_WORDS.length} 枚）。`,
              '',
              renderSection(words, cfg),
            ].join('\n'),
          }
        }
        return { report: inspect(text, words) }
      },
    }), 'ql-speech.tool()')
  }

  // 词表走磁盘正本：异步读，读到就替换（下一次组装提示即生效）。
  void loadWords(wordTableCandidates(cfg.wordTable)).then(({ words: loaded, source }) => {
    words = loaded
    ctx.logger?.info?.('ql-speech：已挂载 · 区块 %s · Agent词 %d 枚 · 词表 %s', SECTION_NAME, loaded.length, source)
  }).catch(() => {
    ctx.logger?.info?.('ql-speech：已挂载 · 区块 %s · Agent词 %d 枚（内置兜底）', SECTION_NAME, words.length)
  })

  ctx.logger?.info?.('ql-speech：系统提示区块 %s 已注册（order=%d，tool=%s）', SECTION_NAME, cfg.order, cfg.tool)
}
