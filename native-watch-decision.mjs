import { randomUUID } from 'node:crypto';

const IMAGE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

// 复用当前 DSH 模型路由和附件接口；不读取模型凭据或普通会话历史。
// 2026-10-23：上限 1200 太紧——决策 JSON 同时带 reason/reflection/topics/diary/say，
// 中文一长就直接被截断，整轮判 failed（实测 15:07 那次 16 次决策白烧）。抬到 2400，并在截断时重试一次更短的。
export function createNativeWatchDecision({ llm, attachments, agent, maxTokens = 2400 }) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 2400) throw new Error('原生模型生成上限须在1至2400之间。');
  const header = agent?.session?.requestHeader?.()?.config;
  const provider = header?.provider ?? agent?.options?.provider;
  const model = header?.model ?? agent?.options?.model;
  if (!provider || !model || typeof llm?.stream !== 'function' || typeof llm?.resolveModelInfo !== 'function') throw new Error('当前 DSH 未提供可核实的模型路由，不能启动自主观看。');
  return async function decide({ system, messages, signal }) {
    signal?.throwIfAborted();
    const info = await llm.resolveModelInfo(provider, model, signal);
    const hasImages = messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
    if (hasImages && (!info?.inputModalities?.includes('image') || typeof attachments?.saveImages !== 'function')) throw new Error('当前 DSH 模型或附件服务不能接收实际视频画面，已停止自主观看。');
    const converted = [];
    for (const message of messages) {
      if(message.role==='system') {if(message.content!==system)throw new Error('自主观看系统提示不一致。');continue;}
      if (!['user','assistant'].includes(message.role)) throw new Error('自主观看只接收本次公开视频的用户或模型消息。');
      const blocks = [];
      for (const part of typeof message.content === 'string' ? [{type:'text',text:message.content}] : message.content || []) {
        if (part.type === 'text') blocks.push({type:'text',text:String(part.text)});
        else if (part.type === 'image_url') {
          const match = IMAGE.exec(part.image_url?.url || '');
          if (!match) throw new Error('自主观看画面格式无效。');
          const data = Buffer.from(match[2], 'base64');
          if (!data.length || data.length > 2_000_000 || data.toString('base64') !== match[2]) throw new Error('自主观看画面超出限制或编码无效。');
          const refs = await attachments.saveImages([{data,mediaType:match[1]}]);
          signal?.throwIfAborted();
          if (!Array.isArray(refs) || refs.length !== 1 || !refs[0]?.attachmentId) throw new Error('DSH 未保存完整的自主观看画面附件。');
          blocks.push({type:'image',attachment:refs[0]});
        } else throw new Error('自主观看请求含未允许的内容类型。');
      }
      converted.push({id:randomUUID(),role:message.role,content:blocks,source:{kind:'plugin',plugin:'douyin-browser',form:'snapshot',sections:[]}});
    }
    // 2026-10-23：模型流没有超时，实测看完之后三分多钟不返回、整轮无声挂住。主人定：20 秒。
    const streamSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
    const runOnce = async (payload) => {
      let text = '', finish, usage = {}; const deltaIndexes = new Set();
      try {
      for await (const chunk of llm.stream({ provider, model, messages: payload, system, maxTokens, signal: streamSignal, sessionId: agent.session.id })) {
        signal?.throwIfAborted();
        if (chunk.type === 'text-delta') {
          deltaIndexes.add(chunk.index);
          text += chunk.text;
          if (text.length > 12_000) throw new Error('自主观看决策超过长度上限。');
        }
        if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !deltaIndexes.has(chunk.index)) text += chunk.block.text;
        if (text.length > 12_000) throw new Error('自主观看决策超过长度上限。');
        if (chunk.type === 'usage') usage = { prompt_tokens: chunk.usage.inputTokens || 0, completion_tokens: chunk.usage.outputTokens || 0, total_tokens: chunk.usage.totalTokens ?? (chunk.usage.inputTokens || 0) + (chunk.usage.outputTokens || 0) };
        if (chunk.type === 'finish') finish = chunk.reason;
      }
      } catch (error) {
        if (!signal?.aborted && streamSignal.aborted) throw new Error('自主观看决策超时（20 秒未返回），本轮收尾。');
        throw error;
      }
      return { text, finish, usage };
    };
    let { text, finish, usage } = await runOnce(converted);
    // 被输出长度截断时补一句"写短点"重试一次，别把整轮判死（图片已在同一上下文里，不重复上传）。
    if (!(finish?.kind === 'stop') && ['max-tokens', 'length'].includes(finish?.kind)) {
      const shorter = converted.concat([{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: '上一次输出被长度限制截断。请只输出一个 JSON 对象，reason、reflection、diary 各控制在 60 字内，topics 最多 2 条，say 最多 20 字。' }], source: { kind: 'plugin', plugin: 'douyin-browser', form: 'snapshot', sections: [] } }]);
      ({ text, finish, usage } = await runOnce(shorter));
    }
    if (finish?.kind !== 'stop' || !text.trim()) throw new Error(`DSH 自主观看决策未完整返回（${finish?.kind || '缺少完成标记'}），未执行动作。`);
    return { text, usage };
  };
}
