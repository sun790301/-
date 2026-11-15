// Claude 串接：主管（可指派任務的 agent）＋ 員工（各自專長的子 agent）＋ 閒聊產生器。
// 沒有 API Key 時改用「示範模式」，用預先寫好的回覆模擬整個流程。

const PRICES = {
  // US$ per 1M tokens: input, output, cache read（估算用）
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.1 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, read: 0.01 },
  'claude-fable-5-2': { in: 8, out: 40, read: 0.2 },
};

export function costOf(model, usage) {
  const p = PRICES[model] || PRICES['claude-opus-5-5'];
  if (!usage) return 0;
  const input = usage.input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const out = usage.output_tokens || 0;
  return (input * p.in + write * p.in * 1.25 + read * p.read + out * p.out) / 1e6;
}

let SDK = null;
async function client(apiKey) {
  if (!SDK) SDK = (await import('@anthropic-ai/sdk')).default;
  return new SDK({ apiKey, dangerouslyAllowBrowser: true });
}

// 共用請求參數：自動 prompt caching；支援的模型開啟伺服器端 refusal fallback。
function baseParams(model, extra) {
  const p = { model, cache_control: { type: 'ephemeral' }, ...extra };
  if (model !== 'claude-haiku-5-5') {
    p.betas = ['server-side-fallback-2026-07-01'];
    p.fallbacks = 'default';
  }
  return p;
}

export function friendlyError(err) {
  const status = err?.status;
  if (status === 401) return 'API Key 無效，請到 ⚙️ 設定重新輸入。';
  if (status === 403) return '這把 API Key 沒有使用此模型的權限。';
  if (status === 429) return '請求太頻繁（429），請稍後再試。';
  if (status === 529 || status >= 500) return 'Anthropic 伺服器忙碌中，請稍後再試。';
  if (status === 400) return `請求格式錯誤：${err?.error?.error?.message || err.message}`;
  return err?.message || String(err);
}

const ASSIGN_TOOL = {
  name: 'assign_task',
  description:
    '把一項具體工作指派給團隊中的一位員工，並取得他完成後的成果。' +
    '可以在同一回合平行指派多項任務給不同員工。只指派真正需要該員工專長的工作。',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      employee: { type: 'string', description: '員工名字，必須是團隊名單中的其中一位' },
      title: { type: 'string', description: '任務的簡短標題（15 字以內），會顯示在辦公室的對話泡泡上' },
      task: { type: 'string', description: '完整的任務說明，包含背景、要求與交付格式' },
    },
    required: ['employee', 'title', 'task'],
    additionalProperties: false,
  },
};

function rosterText(team) {
  return team.employees
    .map((e) => `- ${e.name}（${e.role}）技能：${e.skills.join('、') || '一般事務'}；個性：${e.persona || '普通'}`)
    .join('\n');
}

function managerSystem(team) {
  return [
    `你是 AI Office 的主管「${team.manager.name}」，負責專案「${team.project}」。`,
    '使用者是你的老闆，會用聊天的方式交代工作給你。',
    '你可以用 assign_task 工具把工作分派給員工；員工做完會把成果交回給你。',
    '原則：',
    '1. 簡單的問題或閒聊直接自己回答，不用指派。',
    '2. 需要專業產出時，依照員工技能分派；能平行的工作就同時指派。',
    '3. 收到成果後，整合成一份清楚的回報給老闆，必要時附上員工的完整產出。',
    '4. 一律使用繁體中文，口吻像一位可靠、親切的主管，回覆精簡。',
    '',
    '目前團隊名單：',
    rosterText(team),
  ].join('\n');
}

function employeeSystem(team, emp) {
  return [
    `你是 AI Office 的員工「${emp.name}」，職位是${emp.role}。`,
    `專長：${emp.skills.join('、') || '一般事務'}。個性：${emp.persona || '認真'}。`,
    `你的主管是${team.manager.name}，目前專案是「${team.project}」。`,
    '主管會交給你一項任務。請直接完成並交出成果本身（不要只描述你會怎麼做），使用繁體中文，格式清楚。',
  ].join('\n');
}

/**
 * 主管對話。conversation 物件會在多輪之間保留（只會往後追加，不改寫歷史）。
 * hooks: onText(delta), onThinking(), onAssign({id, employee, title}), onResult({id, employee, result, error}), onUsage(cost)
 */
export class ManagerSession {
  constructor() { this.reset(); }
  reset() { this.messages = []; this.system = null; this.rosterSig = null; }

  async send({ apiKey, model, team, text, hooks }) {
    if (!apiKey) return demoManager({ team, text, hooks });

    const anthropic = await client(apiKey);
    // system prompt 在對話開始時固定；名單有變動時以使用者訊息附註告知，維持歷史只追加。
    const sig = rosterText(team) + team.project;
    if (!this.system) { this.system = managerSystem(team); this.rosterSig = sig; }
    let content = text;
    if (sig !== this.rosterSig) {
      content = `［系統通知：團隊名單已更新］\n${rosterText(team)}\n\n${text}`;
      this.rosterSig = sig;
    }
    this.messages.push({ role: 'user', content });

    let finalText = '';
    for (let round = 0; round < 8; round++) {
      hooks.onThinking?.();
      const stream = anthropic.beta.messages.stream(
        baseParams(model, {
          max_tokens: 32000,
          system: this.system,
          tools: [ASSIGN_TOOL],
          output_config: { effort: 'medium' },
          messages: this.messages,
        }),
      );
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          finalText += ev.delta.text;
          hooks.onText?.(ev.delta.text);
        }
      }
      const msg = await stream.finalMessage();
      hooks.onUsage?.(costOf(model, msg.usage));
      this.messages.push({ role: 'assistant', content: msg.content });

      if (msg.stop_reason === 'refusal') {
        hooks.onText?.('\n（這個請求被模型的安全機制拒絕了，換個說法試試看。）');
        break;
      }
      const uses = msg.content.filter((b) => b.type === 'tool_use');
      if (msg.stop_reason !== 'tool_use' || uses.length === 0) break;
      if (finalText && !finalText.endsWith('\n')) { finalText += '\n'; hooks.onText?.('\n'); }

      // 平行執行所有指派，所有結果放在同一則 user 訊息回傳。
      const results = await Promise.all(
        uses.map(async (u) => {
          const input = u.input || {};
          const emp = team.employees.find((e) => e.name === input.employee);
          if (!emp || typeof input.task !== 'string') {
            return { type: 'tool_result', tool_use_id: u.id, is_error: true,
              content: `找不到員工「${input.employee}」。可指派的員工：${team.employees.map((e) => e.name).join('、')}` };
          }
          hooks.onAssign?.({ id: u.id, employee: emp.name, title: input.title || '新任務', task: input.task });
          try {
            const result = await runEmployee({ anthropic, model, team, emp, task: input.task, hooks });
            hooks.onResult?.({ id: u.id, employee: emp.name, result });
            return { type: 'tool_result', tool_use_id: u.id, content: result };
          } catch (err) {
            const error = friendlyError(err);
            hooks.onResult?.({ id: u.id, employee: emp.name, error });
            return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: `執行失敗：${error}` };
          }
        }),
      );
      this.messages.push({ role: 'user', content: results });
    }
    return finalText;
  }
}

async function runEmployee({ anthropic, model, team, emp, task, hooks }) {
  const stream = anthropic.beta.messages.stream(
    baseParams(model, {
      max_tokens: 32000,
      system: employeeSystem(team, emp),
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: task }],
    }),
  );
  const msg = await stream.finalMessage();
  hooks.onUsage?.(costOf(model, msg.usage));
  if (msg.stop_reason === 'refusal') return '（此任務被模型的安全機制拒絕，無法完成。）';
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return text + (msg.stop_reason === 'max_tokens' ? '\n…（內容過長被截斷）' : '');
}

const CHATTER_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { speaker: { type: 'string' }, text: { type: 'string' } },
        required: ['speaker', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

/** 產生兩位閒置員工的茶水間對話。回傳 [{speaker, text}] */
export async function generateChatter({ apiKey, model, team, a, b, recent, onUsage }) {
  if (!apiKey) return demoChatter(a, b);
  const anthropic = await client(apiKey);
  const prompt = [
    `辦公室裡兩位同事在休息時間閒聊，專案是「${team.project}」。`,
    `${a.name}：${a.role}，個性${a.persona || '普通'}。`,
    `${b.name}：${b.role}，個性${b.persona || '普通'}。`,
    recent.length ? `最近辦公室發生的事：${recent.join('；')}` : '',
    '寫一段 4 句的自然、輕鬆、有點可愛的繁體中文對話，兩人輪流說話，每句 25 字以內。',
    `speaker 只能是「${a.name}」或「${b.name}」。`,
  ].filter(Boolean).join('\n');
  const msg = await anthropic.beta.messages.create(
    baseParams(model, {
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: CHATTER_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    }),
  );
  onUsage?.(costOf(model, msg.usage));
  if (msg.stop_reason === 'refusal') return demoChatter(a, b);
  const text = msg.content.filter((x) => x.type === 'text').map((x) => x.text).join('');
  const lines = JSON.parse(text).lines.filter((l) => l.speaker === a.name || l.speaker === b.name);
  return lines.length ? lines.slice(0, 6) : demoChatter(a, b);
}

/* ---------------- 示範模式 ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typeOut(text, hooks) {
  for (const ch of text) { hooks.onText?.(ch); await sleep(18); }
}

function pickEmployee(team, text) {
  let best = null, score = 0;
  for (const e of team.employees) {
    const words = [e.role, ...e.skills].join(' ');
    let s = 0;
    for (const w of words.split(/[\s,、，]+/).filter(Boolean)) {
      for (let i = 0; i + 1 < w.length; i++) if (text.includes(w.slice(i, i + 2))) s++;
    }
    if (s > score) { best = e; score = s; }
  }
  return best || team.employees[Math.floor(Math.random() * team.employees.length)];
}

async function demoManager({ team, text, hooks }) {
  hooks.onThinking?.();
  await sleep(700);
  if (/^(嗨|hi|hello|哈囉|你好|在嗎|還在|主管)/i.test(text.trim()) || text.trim().length < 6 || !team.employees.length) {
    const t = `在，我在！目前負責的專案是「${team.project}」，小組裡有 ${team.employees.map((e) => `${e.role}${e.name}`).join('、') || '（還沒有成員）'} 可以幫忙。有什麼需要處理的嗎？\n\n（目前是示範模式，到 ⚙️ 設定輸入 API Key 就會由 Claude 真的幫你工作。）`;
    await typeOut(t, hooks);
    return t;
  }
  const emp = pickEmployee(team, text);
  await typeOut(`收到！這件事交給${emp.role}${emp.name}處理最適合，我先請${emp.name}開始動工。\n`, hooks);
  const id = 'demo_' + Date.now();
  const title = text.replace(/\s+/g, ' ').slice(0, 14);
  hooks.onAssign?.({ id, employee: emp.name, title, task: text });
  await sleep(6000 + Math.random() * 3000);
  const result = `【示範產出】\n${emp.name}已完成「${title}」。\n\n這裡在真實模式下會是 Claude 依照${emp.name}的專長（${emp.skills.join('、')}）產生的完整內容。`;
  hooks.onResult?.({ id, employee: emp.name, result });
  await sleep(500);
  const t = `\n${emp.name}已經完成了！重點如下：\n• 任務：${title}\n• 負責人：${emp.name}（${emp.role}）\n\n有需要再調整的地方隨時告訴我。`;
  await typeOut(t, hooks);
  return t;
}

const CANNED = [
  ['今天的咖啡好像特別濃', '因為我偷偷多加了一匙 ☕', '難怪我現在心跳好快', '那剛好，下午的報告靠你了'],
  ['你看到主管新買的盆栽了嗎', '有！它好像比我還有精神', '我們要不要也幫它取名字', '就叫「KPI」吧，天天往上長 🌱'],
  ['週末有什麼計畫？', '想去沖繩看海 🏖️', '哇，記得帶伴手禮', '黑糖還是金楚糕，你選'],
  ['剛剛那份文件我看完了', '感覺怎麼樣？', '寫得很清楚，只有兩個錯字', '好險你有看到，謝啦 🙏'],
  ['加班好累喔', '我請你喝珍奶', '真的嗎！半糖少冰', '收到，馬上下單 🧋'],
];

function demoChatter(a, b) {
  const pick = CANNED[Math.floor(Math.random() * CANNED.length)];
  return pick.map((text, i) => ({ speaker: i % 2 ? b.name : a.name, text }));
}
