window.__ModuleLoader__.load({
  id: 'dsh-douyin-agent',
  factory: require => {
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createElement: h, useEffect, useRef, useState } = React;
    const Button = primitives.Button, Input = primitives.Input || 'input';
    const PREFIX = '/api/douyin-browser';
    const routes = new Set(['/state', '/video/configure', '/video/start', '/video/stop', '/browser/open', '/persona/configure', '/model/configure', '/mode/configure', '/watch/start', '/watch/stop', '/spark/configure', '/spark/start', '/spark/stop', '/spark/resolve', '/comments/configure', '/comments/resolve', '/replies/configure', '/share/configure', '/share/resolve', '/chat/contacts', '/chat/configure', '/chat/start', '/chat/stop', '/chat/resolve', '/media/configure', '/media/credentials', '/reports/generate', '/relay/configure', '/relay/clear']);
    const column = { display: 'flex', flexDirection: 'column', gap: 12 };
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
    // 2026-10-30 主人定：这类补充说明统一 400 字重（跟正文区分开，但不抢视线），长段落要撑开行高。
    const muted = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, fontWeight: 400, lineHeight: 1.65, margin: 0 };
    const formControl = { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 9, maxWidth: '100%', width: '100%', boxSizing: 'border-box' };
    const categories = { '基础设置': ['人格与兴趣', 'DSH 模型', '第三方中转（可选）'], '视频观看': ['视频时间与自主观看'], '好友互动': ['自动续火花', '自主分享作品', '许可好友与自动回复'], '公开评论': ['自主公开视频评论', '回复我的人'], '音频与密钥': ['可选音频'], '观看日报': ['观看日报'] };

    function createSettingsTransport(globals = globalThis) {
      const carrier = globals.__DSH_TRANSPORT__;
      const address = globals.location;
      // local change: the desktop shell serves the UI from dsh-app://app, which is
      // same-origin with the host routes there; the original check only allowed http://localhost.
      const http = address && (address.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) || address.protocol === 'dsh-app:');
      const fetcher = typeof carrier?.fetch === 'function' ? carrier.fetch.bind(carrier) : http && typeof globals.fetch === 'function' ? globals.fetch.bind(globals) : null;
      let token = '';
      return {
        async request(route, input) {
          if (!routes.has(route) && !/^\/reports\/read\?date=\d{4}-\d{2}-\d{2}$/.test(route)) throw new Error('只允许本插件的原生设置接口。');
          if (!fetcher) throw new Error('当前 DSH 没有可用的同源设置服务，请使用支持 WebServer 的原生宿主。');
          if (input !== undefined && !token) throw new Error('请先刷新原生设置页，核实当前状态。');
          const response = await fetcher(PREFIX + route, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(65_000), headers: { 'content-type': 'application/json', ...(input === undefined ? {} : { 'x-douyin-settings-token': token }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
          const value = await response.json();
          if (!response.ok) { const error = new Error(value.error || '原生设置操作未完成。'); error.status = response.status; throw error; }
          if (route === '/state') { if (typeof value.token !== 'string' || !value.token) throw new Error('原生设置未取得有效会话。'); token = value.token; const { token: hidden, ...state } = value; return state; }
          return value;
        },
      };
    }

    function SettingsPage() {
      const [api] = useState(() => createSettingsTransport());
      const [state, setState] = useState(null), [ready, setReady] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
      const [draft, setDraft] = useState({}), [busy, setBusy] = useState(new Set()), [contacts, setContacts] = useState(null), [report, setReport] = useState(null), [reportDate, setReportDate] = useState('');
      const [personaConflict, setPersonaConflict] = useState(false), [reviews, setReviews] = useState(new Set());
      const [category, setCategory] = useState('基础设置'), [credentials, setCredentials] = useState({ mimo: '', minimax: '' });
      const dirty = useRef(new Set()), locks = useRef(new Set()), personaRevision = useRef(null), stateRef = useRef(null), generation = useRef(0), alive = useRef(true), submitted = useRef(new Set());
      const active = value => value?.running === true || value?.starting === true || value?.busy === true || value?.worker?.alive === true;
      const operationActive = active(state?.watch) || active(state?.spark) || active(state?.chat);
      const runningWatch = active(state?.watch), runningSpark = active(state?.spark), runningChat = active(state?.chat);
      async function refresh() {
        const sequence = ++generation.current;
        try { const value = await api.request('/state'); if (!alive.current || sequence !== generation.current) return; stateRef.current = value; setState(value); setReady(true); }
        catch (failure) { if (alive.current && sequence === generation.current) { setReady(false); setError(failure.message); } }
      }
      useEffect(() => { alive.current = true; void refresh(); const timer = setInterval(() => { void refresh(); }, 2500); return () => { alive.current = false; generation.current++; clearInterval(timer); }; }, [api]);
      useEffect(() => {
        if (!state) return;
        const defaults = {
          persona: { content: state.persona?.manualText || '' }, model: { provider: state.model?.provider || '', model: state.model?.model || '' },
          video: { windows: (state.video?.policy?.windows || ['00:00-24:00']).join('\n'), sessionMinutes: state.video?.policy?.sessionMinutes ?? 10 },
          mode: { silent: state.mode?.silent === true },
          spark: { enabled: state.spark?.enabled === true, windows: (state.spark?.policy?.windows || ['09:00-22:00']).join('\n'), dailyLimit: state.spark?.policy?.dailyLimit ?? 2 },
          comments: { enabled: state.comments?.enabled === true },
          replies: { enabled: state.replies?.enabled === true, masterAccount: state.replies?.masterAccount || '', selfAccount: state.replies?.selfAccount || '', perVideo: state.replies?.limits?.perVideo ?? 4 },
          share: { enabled: state.share?.enabled === true, dailyLimit: state.share?.dailyLimit ?? 3 },
          chat: { recipientIds: (state.chat?.policy?.allowlist || []).map(item => item.id), aliases: Object.fromEntries((state.chat?.policy?.allowlist || []).map(item => [item.id, item.alias || ''])), dailyReplyLimit: state.chat?.policy?.dailyReplyLimit ?? 40 },
          media: { enabled: state.media?.enabled === true, backend: state.media?.backend || 'local-whisper' },
          relay: { baseUrl: state.relay?.baseUrl || '', model: state.relay?.model || '', apiKey: '' },
        };
        setDraft(old => ({ ...old, ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !dirty.current.has(key))) }));
        if (!dirty.current.has('persona')) personaRevision.current = state.persona?.revision;
        if (!reportDate && state.reports?.date) setReportDate(state.reports.date);
      }, [state]);
      function edit(section, key, value) {
        if (section === 'persona' && !dirty.current.has('persona')) personaRevision.current = stateRef.current?.persona?.revision;
        dirty.current.add(section); setNotice(''); setDraft(old => ({ ...old, [section]: { ...old[section], [key]: value } }));
      }
      async function perform(key, action, section) {
        if (!ready || locks.current.has(key)) return;
        locks.current.add(key); setBusy(new Set(locks.current)); setError(''); setNotice('');
        try { const value = await action(); if (section) dirty.current.delete(section); setNotice('操作已提交，请以回读状态为准。'); await refresh(); return value; }
        catch (failure) { if (key === 'persona' && failure.status === 409) { setPersonaConflict(true); setError('人格文件已更新，草稿已保留。请比较后选择载入最新人格再保存。'); } else setError(failure.message || '操作未完成。'); await refresh(); }
        finally { locks.current.delete(key); setBusy(new Set(locks.current)); }
      }
      const post = (key, route, value, section) => { void perform(key, () => api.request(route, value), section); };
      const value = (section, key, fallback = '') => draft[section]?.[key] ?? fallback;
      const windows = section => value(section, 'windows').split(/[\n,;，；]+/).map(item => item.trim()).filter(Boolean);
      const button = (text, key, callback, disabled = false) => h(Button, { type: 'button', size: 'sm', variant: 'outline', style: { alignSelf: 'flex-start' }, disabled: !ready || busy.has(key) || disabled, onClick: callback }, busy.has(key) ? '处理中…' : text);
      const input = (label, section, key, extra = {}) => h('label', { style: column }, h('span', null, label), h(Input, { 'aria-label': label, value: value(section, key), disabled: !ready, onChange: event => edit(section, key, event.target.value), ...extra }));
      const textarea = (label, section, key, rows = 2) => h('label', { style: column }, h('span', null, label), h('textarea', { 'aria-label': label, rows, value: value(section, key), disabled: !ready, onChange: event => edit(section, key, event.target.value), style: formControl, maxLength: section === 'persona' ? 40000 : 220 }));
      const toggle = (label, section, key = 'enabled') => h('label', { style: row }, h('input', { type: 'checkbox', 'aria-label': label, checked: value(section, key, false) === true, disabled: !ready, onChange: event => edit(section, key, event.target.checked) }), label);
      // 2026-10-26 主人定：像壁纸引擎那样按大类做横向标签页，一次只显示一个分类。
      const section = (title, ...children) => {
        const owner = Object.keys(categories).find(name => categories[name].includes(title));
        if (!owner || owner !== category) return null;
        return h('section', { role: 'tabpanel', 'aria-label': title, style: { ...column, borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: 24, marginBottom: 24 } },
          h('h3', { style: { margin: 0 } }, title), ...children);
      };
      const note = (text, key) => h('p', { key, style: muted }, text);
      const modelLink = () => h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => setCategory('基础设置') }, '前往模型设置');
      // 「请先开始允许时段内的有限轮次」由上面 video.reason 那行负责，这里不重复第二遍。
      const watchReason = runningWatch ? '自主观看正在运行。' : !state?.model?.configured ? '请先在基础设置中选择并保存模型。' : '';
      const sparkReason = runningSpark ? '自动问候正在运行。' : !state?.model?.configured ? '请先在基础设置中选择并保存模型，再开始自动问候。' : dirty.current.has('spark') ? '请先保存问候许可。' : !state?.spark?.enabled ? '请先开启并保存主动问候许可。' : '';
      const chatReason = runningChat ? '自动回复正在运行。' : !state?.model?.configured ? '请先在基础设置中选择并保存模型。' : dirty.current.has('chat') ? '请先保存许可好友。' : !(state?.chat?.policy?.allowlist || []).length ? '请先读取并保存许可好友。' : '';
      function credentialForm(backend, label) {
        const credential = state?.media?.backends?.[backend]?.credential;
        return h('div', { key: backend, style: column }, h('label', { style: column }, h('span', null, `${label} API Key`), h(Input, { type: 'password', 'aria-label': `${label} API Key`, autoComplete: 'off', maxLength: 4096, value: credentials[backend], disabled: !ready || operationActive || busy.has(`key:${backend}`), placeholder: credential?.configured ? '已配置；填写后替换' : '填写音频服务 API Key', onChange: event => setCredentials(old => ({ ...old, [backend]: event.target.value })) })),
          button(`保存 ${label} Key`, `key:${backend}`, () => { void perform(`key:${backend}`, async () => { const result = await api.request('/media/credentials', { backend, apiKey: credentials[backend] }); setCredentials(old => ({ ...old, [backend]: '' })); return result; }); }, operationActive || !credentials[backend].trim()),
          note(credential?.environmentOverride ? '当前进程的环境变量优先；共享文件中的 Key 不覆盖它。' : credential?.configured ? '已配置，不回显已保存的 Key。' : '尚未配置。音频可以保持关闭。'));
      }
      function resolve(kind, item, outcome) {
        const key = `${kind}:${item.operationId}`; if (submitted.current.has(key)) return;
        submitted.current.add(key); setReviews(new Set(submitted.current));
        void perform(key, async () => { try { return await api.request(`/${kind}/resolve`, { operationId: item.operationId, outcome }); } catch (failure) { submitted.current.delete(key); setReviews(new Set(submitted.current)); throw failure; } });
      }
      const reviewList = kind => (state?.[kind]?.needsReview || []).map(item => {
        const key = `${kind}:${item.operationId}`;
        return h('div', { key, style: column }, note(`待核对：${item.videoId ? `作品 ${item.videoId}` : '许可好友问候'} · ${item.status || ''}`), reviews.has(key) ? note('核对结果已提交，等待回读，不会重复提交。') : h('div', { style: row }, button('已核对发送成功', key, () => resolve(kind, item, 'confirmed'), kind === 'spark' && runningSpark), button('已核对未发送', key, () => resolve(kind, item, 'not-sent'), kind === 'spark' && runningSpark)));
      });
      const remaining = state?.video?.remainingSeconds ?? 0;
      const tabbar = h('div', { role: 'tablist', 'aria-label': '插件分区', style: { display: 'flex', gap: 4, flexWrap: 'wrap', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: 4, margin: '4px 0 20px' } },
        ...Object.keys(categories).map(name => h('button', {
          key: name, type: 'button', role: 'tab', 'aria-selected': name === category,
          style: { flex: '1 1 auto', font: 'inherit', fontSize: 14, padding: '8px 12px', border: 'none', borderRadius: 8, cursor: 'pointer',
            background: name === category ? 'var(--dsw-alias-bg-base)' : 'transparent',
            color: name === category ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
            fontWeight: name === category ? 600 : 400 },
          onClick: () => setCategory(name),
        }, name)));

      return h('div', { style: { maxWidth: 900, color: 'var(--dsw-alias-label-primary)', paddingBottom: 32 } },
        h('h2', null, '大肥鱼抖音助手'),
        !ready && h('p', { role: 'status' }, '正在核实插件状态；未就绪时不会启用或启动任何功能。'),
        error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
        h('div', { style: row }, button('刷新插件状态', 'refresh', () => { void refresh(); })), tabbar,
      // 横向大类标签（对应 categories 里的六个分组）
        section('DSH 模型', note('使用 DSH 已配置提供商；观看、问候和私信按本页模型设置运行。'),
          h('label', { style: column }, '模型提供商', h('select', { 'aria-label': '模型提供商', style: formControl, value: value('model', 'provider'), disabled: !ready || operationActive, onChange: event => { edit('model', 'provider', event.target.value); edit('model', 'model', ''); } }, h('option', { value: '' }, '请选择 DSH 提供商'), ...(state?.model?.providers || []).map(item => h('option', { key: item.id, value: item.id }, item.name || item.id)))),
          h('label', { style: column }, '模型名称', h('select', { 'aria-label': '模型名称', style: formControl, value: value('model', 'model'), disabled: !ready || operationActive || !value('model', 'provider'), onChange: event => edit('model', 'model', event.target.value) }, h('option', { value: '' }, '请选择模型'), ...(state?.model?.models || []).filter(item => item.provider === value('model', 'provider')).map(item => h('option', { key: item.id, value: item.id }, item.name || item.id)))),
          value('model', 'provider') && !(state?.model?.models || []).some(item => item.provider === value('model', 'provider')) && note('该提供商尚无可选模型，请先在 DSH 的模型设置中配置或刷新模型列表。'),
          ...(state?.model?.catalogErrors || []).filter(item => item.provider === value('model', 'provider')).map(item => note(item.message, item.provider)),
          button('保存模型设置', 'model', () => post('model', '/model/configure', { provider: value('model', 'provider'), model: value('model', 'model').trim() }, 'model'), operationActive || !value('model', 'provider') || !value('model', 'model').trim()), note(state?.model?.configured ? '模型已配置。' : '请先配置并核实 DSH 模型。')),
        section('人格与兴趣', note('手编人格与软件共用；自动兴趣和观察单独记录。未保存的草稿不会被状态轮询覆盖。'), textarea('大肥鱼人格正文', 'persona', 'content', 14),
          personaConflict && note('人格存在版本冲突，请先比较草稿和最新正文。'),
          h('div', { style: row }, button('保存人格', 'persona', () => post('persona', '/persona/configure', { content: value('persona', 'content'), expectedRevision: personaRevision.current }, 'persona'), operationActive || personaConflict), button('载入最新人格（替换草稿）', 'personaReload', () => { dirty.current.delete('persona'); setDraft(old => ({ ...old, persona: { content: state.persona?.manualText || '' } })); personaRevision.current = state.persona?.revision; setPersonaConflict(false); })),
          h('details', null, h('summary', null, '查看最新人格正文'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, state?.persona?.manualText || '尚未填写')),
          note(state?.persona?.personaFolder || '人格文件夹位置正在读取。')),
        section('第三方中转（可选）',
          note('填了就让插件自己的模型调用走这个中转；不填就走 DSH 已配置的模型。只影响刷抖音这一侧，不影响主对话。'),
          note(state?.relay?.hasKey ? `当前：${state.relay.baseUrl} ｜ ${state.relay.model} ｜ Key ${state.relay.keyHint}` : '当前未配置中转。'),
          input('Base URL', 'relay', 'baseUrl', { placeholder: 'https://example.com/v1' }),
          input('模型名', 'relay', 'model', { placeholder: 'claude-haiku-4-5' }),
          h('label', { style: column }, h('span', null, 'API Key'), h(Input, { type: 'password', 'aria-label': '中转 API Key', autoComplete: 'off', maxLength: 4096, value: value('relay', 'apiKey'), disabled: !ready, placeholder: state?.relay?.hasKey ? '已配置；留空则保留原 Key' : '粘贴中转站给你的 Key', onChange: event => edit('relay', 'apiKey', event.target.value) })),
          h('div', { style: row },
            button('保存中转设置', 'relaySave', () => { void perform('relaySave', async () => { const result = await api.request('/relay/configure', { baseUrl: value('relay', 'baseUrl').trim(), model: value('relay', 'model').trim(), apiKey: value('relay', 'apiKey').trim() }); setDraft(old => ({ ...old, relay: { ...old.relay, apiKey: '' } })); return result; }, 'relay'); }),
            button('清除（回到 DSH 模型）', 'relayClear', () => post('relayClear', '/relay/clear', {}, 'relay'), !state?.relay?.configured)),
          note('提醒：DeepSeek 系列在这个中转上通常看不见图片，而刷抖音的判断靠画面——优先选支持视觉的模型（如 claude-haiku-4-5）。'),
        ),
        section('视频时间与自主观看', textarea('每日允许视频时段（北京时间）', 'video', 'windows'), input('单轮上限（分钟）', 'video', 'sessionMinutes', { type: 'number', min: 1, max: 1440 }),
          button('保存视频时间', 'video', () => post('video', '/video/configure', { windows: windows('video'), sessionMinutes: Number(value('video', 'sessionMinutes')) }, 'video')),
          note(state?.video?.reason || `当前轮次剩余 ${remaining} 秒。`), h('div', { style: row }, button('开始有限轮次', 'videoStart', () => post('videoStart', '/video/start', {}), runningWatch), button('结束本轮', 'videoStop', () => post('videoStop', '/video/stop', {}))),
          h('div', { style: row }, button('开始自主观看', 'watchStart', () => post('watchStart', '/watch/start', {}), runningWatch || !state?.video?.allowed || !state?.model?.configured), button('停止自主观看', 'watchStop', () => post('watchStop', '/watch/stop', {}), !runningWatch)),
          watchReason && note(watchReason), !state?.model?.configured && modelLink(),
          note('先开始有限轮次，再启动自主观看；轮次用完即停，每天最多 200 次模型请求兜底。'),
          note('12 秒以内的短片看到尾不花请求；同一条作品最多连看 25 秒就重新采样。'),
          toggle('静默观看', 'mode', 'silent'), button('保存静默设置', 'mode', () => post('mode', '/mode/configure', { silent: value('mode', 'silent', false) === true }, 'mode')), note(state?.mode?.note || '静默模式不延长轮次，也不保证网站始终允许后台播放。')),
        section('自动续火花', toggle('允许主动问候', 'spark'), textarea('每日问候时段（北京时间）', 'spark', 'windows'), input('每日主动问候总上限', 'spark', 'dailyLimit', { type: 'number', min: 1, max: 10 }),
          button('保存问候许可', 'spark', () => { void perform('spark', async () => { const result = await api.request('/spark/configure', { enabled: value('spark', 'enabled', false), windows: windows('spark'), dailyLimit: Number(value('spark', 'dailyLimit', 2)) }); if (!value('spark', 'enabled', false)) await api.request('/spark/stop', {}); return result; }, 'spark'); }),
          h('div', { style: row }, button('开始自动问候', 'sparkStart', () => post('sparkStart', '/spark/start', {}), runningSpark || !state?.spark?.enabled || !state?.model?.configured || dirty.current.has('spark')), button('停止自动问候', 'sparkStop', () => post('sparkStop', '/spark/stop', {}), !runningSpark)),
          sparkReason && note(sparkReason), !state?.model?.configured && modelLink(),
          note(`许可：${state?.spark?.enabled ? '已开启' : '未开启'}；服务：${runningSpark ? '运行中' : '未运行'}。保存许可不会发送，点开始后才会在允许时段发出。`),
          note('每位好友每天最多尝试一次：今天已经发过、或时间标签读不出来，就不打扰。问候送达不等于火花增加，以抖音判定和对方回应为准。'),
          note('问候文案每次由模型现场生成，没有固定模板，只发给上面白名单里的好友。'),
          ...(state?.spark?.recipients || []).map(item => note(`${item.name || '许可好友'}${item.alias ? '（称呼 ' + item.alias + '）' : ''}：${item.reason || item.status || '等待检查'}`, item.id)), ...reviewList('spark')),
          ...(state?.spark?.today || []).map(item => { const contact = (state?.spark?.recipients || []).find(one => one.id === item.recipientId); return note(`${contact?.name || '好友'}${contact?.alias ? '（称呼 ' + contact.alias + '）' : ''}：${item.status}${item.text ? '「' + item.text + '」' : ''}`, 'g:' + item.recipientId); }),
        state?.share && section('自主分享作品', toggle('允许自主分享', 'share'), input('分享每日尝试上限', 'share', 'dailyLimit', { type: 'number', min: 1, max: 20 }), button('保存分享许可', 'share', () => post('share', '/share/configure', { enabled: value('share', 'enabled', false), dailyLimit: Number(value('share', 'dailyLimit', 3)) }, 'share')), note('只在有限自主观看中选择当前观察的作品及许可好友；未确认不自动重发。'), ...reviewList('share')),
        state?.chat && section('许可好友与自动回复', note(`服务：${runningChat ? '运行中' : '未运行'}；跟随自主观看自动启动，白名单最多十位，启动后可补发历史未回消息。`), button('读取已关注联系人', 'chatList', () => { void perform('chatList', async () => { const result = await api.request('/chat/contacts', {}); if (result.blocked || result.loginRequired || result.verificationRequired || !Array.isArray(result.contacts)) throw new Error('请在专用抖音窗口完成登录或验证。'); setContacts(result.contacts); }); }, runningChat),
          ...(contacts || state.chat.policy?.allowlist || []).map(item => h('label', { key: item.id, style: row }, h('input', { type: 'checkbox', 'aria-label': `许可联系人 ${item.name || item.displayName || '联系人'}`, checked: value('chat', 'recipientIds', []).includes(item.id), disabled: !ready || runningChat || item.followed !== true || item.isGroup !== false || !value('chat', 'recipientIds', []).includes(item.id) && value('chat', 'recipientIds', []).length >= 10, onChange: event => edit('chat', 'recipientIds', event.target.checked ? [...value('chat', 'recipientIds', []), item.id] : value('chat', 'recipientIds', []).filter(id => id !== item.id)) }), item.name || item.displayName || '许可好友', h('div', { style: { width: 200 } }, h(Input, { 'aria-label': `备注称呼 ${item.name || item.displayName || '联系人'}`, placeholder: '备注：回复时怎么称呼', maxLength: 30, value: (value('chat', 'aliases', {}) || {})[item.id] || '', disabled: !ready || runningChat, onChange: event => edit('chat', 'aliases', { ...(value('chat', 'aliases', {}) || {}), [item.id]: event.target.value }) })))),
          input('私信每日模型请求上限', 'chat', 'dailyReplyLimit', { type: 'number', min: 1, max: 200 }), h('div', { style: row }, button('保存许可好友', 'chat', () => post('chat', '/chat/configure', { recipientIds: value('chat', 'recipientIds', []), aliases: value('chat', 'aliases', {}), dailyReplyLimit: Number(value('chat', 'dailyReplyLimit', 40)) }, 'chat'), runningChat), button('启用私信自动回复', 'chatStart', () => post('chatStart', '/chat/start', {}), runningChat || !state?.model?.configured || !(state.chat.policy?.allowlist || []).length || dirty.current.has('chat')), button('停止私信回复', 'chatStop', () => post('chatStop', '/chat/stop', {}), !runningChat)),
          chatReason && note(chatReason),
          ...(state.chat.contacts || []).filter(item => item.status !== 'ready').map(item => h('div', { key: item.id }, note(item.reason || item.status), button('已人工核对该会话', `chatResolve:${item.id}`, () => post(`chatResolve:${item.id}`, '/chat/resolve', { recipientId: item.id }), runningChat)))),
        section('自主公开视频评论', toggle('允许自主发布评论', 'comments'),
          button('保存评论许可', 'comments', () => post('comments', '/comments/configure', { enabled: value('comments', 'enabled', false) }, 'comments')),
          note('只在作品播到结尾、宿主停住问一次时，才由大肥鱼决定要不要公开评论；不接受中途评论，也不含人格、私信或 QQ 内容。'),
          note('每部作品永久去重，只可能评一次；结果未确认时暂停，不退次数、不自动重发。'),
          note(`今日已尝试 ${state?.comments?.daily?.attempts ?? 0} 次，本轮 ${state?.comments?.session?.attempts ?? 0} 次。`), ...reviewList('comments')),
        state?.replies && section('回复我的人', toggle('允许自动回复', 'replies'),
          input('主人账号', 'replies', 'masterAccount', { placeholder: '例如：测试用小猫' }),
          input('大肥鱼账号', 'replies', 'selfAccount', { placeholder: '例如：XY猫猫老师' }),
          input('每部作品最多回复几次', 'replies', 'perVideo', { type: 'number', min: 1, max: 50 }),
          button('保存回复设置', 'replies', () => post('replies', '/replies/configure', { enabled: value('replies', 'enabled', false), masterAccount: value('replies', 'masterAccount').trim(), selfAccount: value('replies', 'selfAccount').trim(), perVideo: Number(value('replies', 'perVideo', 4)) }, 'replies')),
          note(`别人回复大肥鱼的评论时，由宿主自动回一条。每部作品最多回 ${state?.replies?.limits?.perVideo ?? 4} 条（可在上面改），主人账号不计入这个数；同一条回复只回一次，结果未核对就暂停，不自动重发。`),
          note(`已确认回复 ${state?.replies?.counts?.confirmed ?? 0} 条；许可：${state?.replies?.enabled ? '已开启' : '未开启'}${state?.replies?.paused ? '；有未核对结果，已暂停' : ''}。`)),
        state?.media && section('可选音频', toggle('读取视频声音', 'media'), h('label', { style: column }, '音频后端', h('select', { 'aria-label': '音频后端', value: value('media', 'backend', 'local-whisper'), disabled: !ready, style: formControl, onChange: event => edit('media', 'backend', event.target.value) }, h('option', { value: 'local-whisper' }, '本机 Whisper'), h('option', { value: 'mimo' }, 'MiMo'), h('option', { value: 'minimax' }, 'MiniMax'))), button('保存音频设置', 'media', () => post('media', '/media/configure', { enabled: value('media', 'enabled', false), backend: value('media', 'backend', 'local-whisper') }, 'media')), note('音频可以不接入。下面这些 Key 只用于对应的云音频服务，和 DSH 主模型分开，明文保存在本机共享媒体文件里。'),
          note('保存 Key 不会开启音频，也不会发起云请求，更不会安装依赖或下载模型。'), credentialForm('mimo', 'MiMo'), credentialForm('minimax', 'MiniMax'), operationActive && note('请先停止自主观看、问候及私信回复，再更换音频 Key。')),
        section('观看日报', note(state?.reports?.folder || '日报保存在共用记忆的 reports/videos 目录。'), button('生成今天日报', 'reportGenerate', () => { void perform('reportGenerate', async () => { const result = await api.request('/reports/generate', {}); setReport(result); return result; }); }),
          h('label', { style: column }, '日报日期', h('input', { 'aria-label': '日报日期', type: 'date', value: reportDate, onChange: event => setReportDate(event.target.value), style: formControl })),
          button('读取所选日报', 'reportRead', () => { void perform('reportRead', async () => { if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error('请选择有效日报日期。'); const result = await api.request(`/reports/read?date=${reportDate}`); setReport(result); return result; }); }),
          note('日报只整理已记录的观看证据，不调用模型，也不会新增浏览。'), ...(state?.reports?.reports || []).map(item => note(`${item.date} · ${item.observedCount ?? 0} 项观察 · 已核实进度 ${item.verifiedProgressSeconds ?? 0} 秒`, item.date)), report && h('pre', { 'aria-label': '日报内容', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' } }, report.markdown || '该日报没有可显示正文。'))
      );
    }
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'douyin-browser', order: 16, label: () => '刷抖音' }, SettingsPage));
    }
    return { name: 'douyin-browser-settings', inject: ['slots'], apply, SettingsPage, createSettingsTransport };
  },
});
