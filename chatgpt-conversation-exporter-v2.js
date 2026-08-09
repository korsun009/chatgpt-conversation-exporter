/*
 * ChatGPT Conversation Exporter v2.0.3
 * Автономный bookmarklet / DevTools Snippet без внешних зависимостей.
 * Экспортирует только данные, доступные открытой странице и текущей сессии.
 */
(function bootstrap(factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  } else {
    core.run().catch(error => {
      console.error('[ChatGPT Exporter v2]', error);
      alert(`Экспорт не выполнен.\n\n${error?.message || error}`);
    });
  }
})(function createExporter() {
  'use strict';

  const VERSION = '2.0.3';
  const RUN_KEY = '__CHATGPT_CONVERSATION_EXPORTER_V2__';
  const SETTINGS_KEY = 'chatgpt-conversation-exporter-v2-settings';
  const API_CONTEXT = Symbol('chatgpt-exporter-api-context');
  const encoder = new TextEncoder();

  const cleanText = value => String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const safeFileName = (value, fallback = 'ChatGPT Conversation') => {
    let result = cleanText(value)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim();
    if (!result) result = fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
    return result.slice(0, 160).replace(/[. ]+$/g, '') || fallback;
  };

  const buildExportBaseName = ({ projectTitle, conversationTitle }) => {
    const chat = safeFileName(conversationTitle || 'ChatGPT Conversation');
    const project = cleanText(projectTitle);
    return project ? safeFileName(`${project} - ${chat}`) : chat;
  };

  const getConversationId = value => {
    try {
      const url = new URL(value, 'https://chatgpt.com');
      const match = url.pathname.match(/(?:^|\/)c\/([^/?#]+)/i);
      return match ? decodeURIComponent(match[1]) : '';
    } catch (_) {
      return '';
    }
  };

  const getProjectId = value => {
    try {
      const url = new URL(value, 'https://chatgpt.com');
      const match = url.pathname.match(/(?:^|\/)(g-p-[^/?#]+)(?:\/|$)/i);
      if (!match) return '';
      const raw = decodeURIComponent(match[1]);
      const canonical = raw.match(/^(g-p-[a-f0-9]{32})(?:-|$)/i);
      return canonical ? canonical[1] : raw;
    } catch (_) {
      return '';
    }
  };

  const getOwnerUserId = value => {
    try {
      return cleanText(new URL(value, 'https://chatgpt.com').searchParams.get('owner_user_id') || '');
    } catch (_) {
      return '';
    }
  };

  const buildChatGptHeaders = ({ accessToken = '', projectId = '', ownerUserId = '' } = {}) => {
    const headers = { Accept: 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (projectId) headers['chatgpt-project-id'] = projectId;
    if (ownerUserId) headers['chatgpt-conv-owner-id'] = ownerUserId;
    return headers;
  };

  const getChatGptApiContext = async ({ fetchFn = fetch, pageUrl = location.href } = {}) => {
    const response = await fetchFn('/api/auth/session', { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`не удалось получить сессию: HTTP ${response.status}`);
    const session = await response.json();
    const accessToken = cleanText(session?.accessToken || '');
    if (!accessToken) throw new Error('текущая сессия не содержит access token');
    return {
      accessToken,
      projectId: getProjectId(pageUrl),
      ownerUserId: getOwnerUserId(pageUrl),
      fetchFn,
      pageUrl
    };
  };

  const parseUiTimestampLabel = (label, now = new Date()) => {
    const value = cleanText(label).toLocaleLowerCase('ru-RU');
    const time = value.match(/(?:^|,\s*)([01]?\d|2[0-3]):([0-5]\d)\s*$/);
    if (!time) return null;
    const hours = Number(time[1]);
    const minutes = Number(time[2]);
    if (value.startsWith('сегодня')) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
    if (value.startsWith('вчера')) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hours, minutes);
    const months = { января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5, июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11 };
    const absolute = value.match(/^(\d{1,2})\s+([а-яё]+)\s+(\d{4})(?:\s*г\.)?,/i);
    if (!absolute || months[absolute[2]] === undefined) return null;
    return new Date(Number(absolute[3]), months[absolute[2]], Number(absolute[1]), hours, minutes);
  };

  const isoFromValue = value => {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    const date = Number.isFinite(numeric)
      ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
      : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };

  const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value];

  const contentToText = content => {
    if (!content) return '';
    if (typeof content === 'string') return cleanText(content);
    const parts = asArray(content.parts);
    const values = parts.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return part.text || part.content || part.caption || part.name || '';
    });
    return cleanText(values.join('\n'));
  };

  const uniqueBy = (items, keyFn) => {
    const seen = new Set();
    return items.filter(item => {
      const key = keyFn(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const normalizeSource = source => {
    if (!source) return null;
    if (typeof source === 'string') return /^https?:/i.test(source) ? { title: source, url: source } : null;
    const metadata = source.metadata || source;
    const url = metadata.url || metadata.uri || metadata.href || metadata.source_url || '';
    if (!/^https?:/i.test(url)) return null;
    return {
      title: cleanText(metadata.title || metadata.name || metadata.domain || url),
      url,
      domain: cleanText(metadata.domain || (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })()),
      cited_text: cleanText(metadata.text || metadata.snippet || metadata.cited_text || '') || null
    };
  };

  const collectSources = (message, text) => {
    const metadata = message?.metadata || {};
    const candidates = [
      ...asArray(metadata.citations),
      ...asArray(metadata.sources),
      ...asArray(metadata.content_references),
      ...asArray(message?.content?.references)
    ];
    const urlMatches = String(text || '').match(/https?:\/\/[^\s)\]}>"']+/g) || [];
    candidates.push(...urlMatches);
    return uniqueBy(candidates.map(normalizeSource).filter(Boolean), item => item.url);
  };

  const normalizeToolCall = value => {
    if (!value || typeof value !== 'object') return null;
    const name = cleanText(value.name || value.tool_name || value.type || value.recipient || value.author?.name || 'Инструмент');
    return {
      name,
      status: cleanText(value.status || value.state || value.result_status || 'unknown'),
      input: cleanText(typeof value.input === 'string' ? value.input : value.input ? JSON.stringify(value.input, null, 2) : value.arguments || ''),
      output: cleanText(typeof value.output === 'string' ? value.output : value.output ? JSON.stringify(value.output, null, 2) : value.result || ''),
      started_at: isoFromValue(value.started_at || value.start_time),
      finished_at: isoFromValue(value.finished_at || value.end_time)
    };
  };

  const collectToolCalls = message => {
    const metadata = message?.metadata || {};
    const candidates = [
      ...asArray(metadata.tool_calls),
      ...asArray(metadata.invoked_tools),
      ...asArray(metadata.command),
      ...asArray(message?.content?.tool_calls)
    ];
    if (message?.author?.role === 'tool' || message?.recipient) candidates.push(message);
    return candidates.map(normalizeToolCall).filter(Boolean);
  };

  const buildAttachmentDownloadUrl = (attachment, messageId, conversationId) => {
    const sandboxPath = cleanText(attachment?.sandbox_path || attachment?.filepath || '');
    if (sandboxPath && messageId && conversationId) {
      return `/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?message_id=${encodeURIComponent(messageId)}&sandbox_path=${encodeURIComponent(sandboxPath)}`;
    }
    const rawId = cleanText(attachment?.id || attachment?.file_id || attachment?.asset_pointer || '');
    const fileId = rawId.replace(/^sediment:\/\//i, '');
    if (/^file_/i.test(fileId)) return `/backend-api/files/download/${encodeURIComponent(fileId)}?inline=false&download_intent=true`;
    return cleanText(attachment?.download_url || attachment?.source_url || attachment?.url || attachment?.href || attachment?.asset_url || '');
  };

  const normalizeAttachment = value => {
    if (!value) return null;
    const item = typeof value === 'string' ? { name: value } : value;
    const name = cleanText(item.name || item.filename || item.title || item.file_name || item.id || 'attachment');
    const rawId = cleanText(item.id || item.file_id || item.asset_pointer || '');
    const id = rawId.replace(/^sediment:\/\//i, '');
    const sandboxPath = cleanText(item.sandbox_path || item.filepath || '');
    const sourceUrl = buildAttachmentDownloadUrl({ ...item, id, sandbox_path: sandboxPath });
    return {
      id,
      original_name: safeFileName(name, 'attachment'),
      source_url: sourceUrl,
      sandbox_path: sandboxPath || null,
      mime_type: cleanText(item.mime_type || item.content_type || ''),
      size: Number(item.size || 0) || null,
      status: 'pending'
    };
  };

  const collectAttachments = message => {
    const metadata = message?.metadata || {};
    const candidates = [
      ...asArray(metadata.attachments),
      ...asArray(metadata.files),
      ...asArray(message?.content?.attachments)
    ];
    for (const part of asArray(message?.content?.parts)) {
      if (part && typeof part === 'object' && (part.asset_pointer || part.url || part.file_id)) candidates.push(part);
    }
    return uniqueBy(candidates.map(normalizeAttachment).filter(Boolean), item => item.id || item.source_url || item.original_name);
  };

  const collectVisibleFileCards = (root, messageId, role) => {
    if (!root?.querySelectorAll) return [];
    const result = [];
    const buttons = [...root.querySelectorAll('button[aria-label]')];
    for (const button of buttons) {
      const name = cleanText(button.getAttribute('aria-label'));
      if (!name || !/\.[a-z0-9]{1,12}$/i.test(name)) continue;
      const container = button.parentElement;
      const hasDownloadButton = [...(container?.querySelectorAll('button[aria-label]') || [])]
        .some(candidate => candidate !== button && /скачать|download/i.test(candidate.getAttribute('aria-label') || ''));
      if (!hasDownloadButton) continue;
      result.push(normalizeAttachment({
        name,
        sandbox_path: role === 'assistant' ? `/mnt/data/${name}` : '',
        message_id: messageId
      }));
    }
    return uniqueBy(result.filter(Boolean), item => `${messageId}:${item.original_name}`);
  };

  const enrichMessagesFromDom = (messages, doc = document) => {
    const byId = new Map(messages.map(message => [message.id, message]));
    doc.querySelectorAll('[data-message-author-role]').forEach(element => {
      const turn = element.closest('[data-testid^="conversation-turn-"]') || element.parentElement;
      const messageId = element.getAttribute('data-message-id') || turn?.getAttribute('data-message-id') || '';
      const message = byId.get(messageId);
      if (!message) return;
      const cards = collectVisibleFileCards(turn || element, messageId, message.role);
      message.attachments = uniqueBy([...(message.attachments || []), ...cards], item => item.id || item.source_url || `${message.id}:${item.original_name}`);
      if (!message.created_at) {
        const candidates = [...(turn?.querySelectorAll('time, [aria-label], [title]') || [])];
        for (const candidate of candidates) {
          const parsed = parseUiTimestampLabel(candidate.dateTime || candidate.getAttribute('aria-label') || candidate.getAttribute('title') || candidate.textContent || '');
          if (parsed) { message.created_at = parsed.toISOString(); break; }
        }
      }
    });
    return messages;
  };

  const extractVisibleReasoning = message => {
    const metadata = message?.metadata || {};
    const content = message?.content || {};
    const candidates = [
      metadata.reasoning_summary,
      metadata.thoughts,
      metadata.visible_reasoning,
      content.content_type === 'thoughts' ? contentToText(content) : '',
      content.thoughts,
      content.reasoning
    ];
    return cleanText(candidates.find(value => cleanText(value)) || '') || null;
  };

  const normalizeMappingNode = node => {
    const message = node?.message;
    if (!message) return null;
    const text = contentToText(message.content);
    const role = cleanText(message.author?.role || 'unknown');
    return {
      id: cleanText(message.id || node.id),
      parent_id: node.parent || null,
      children_ids: asArray(node.children),
      role,
      author_name: cleanText(message.author?.name || '') || null,
      created_at: isoFromValue(message.create_time),
      updated_at: isoFromValue(message.update_time),
      model: cleanText(message.metadata?.model_slug || message.metadata?.default_model_slug || '') || null,
      content_type: cleanText(message.content?.content_type || 'text'),
      text,
      markdown: text,
      content_parts: asArray(message.content?.parts),
      visible_reasoning: extractVisibleReasoning(message),
      sources: collectSources(message, text),
      tool_calls: collectToolCalls(message),
      attachments: collectAttachments(message),
      raw_metadata: message.metadata || {}
    };
  };

  const selectMappingMessages = (conversation, branchMode = 'current') => {
    const mapping = conversation?.mapping || {};
    let nodes;
    if (branchMode === 'all') {
      nodes = Object.values(mapping).filter(node => node?.message);
      nodes.sort((a, b) => {
        const at = Number(a.message?.create_time || 0);
        const bt = Number(b.message?.create_time || 0);
        return at - bt || String(a.id).localeCompare(String(b.id));
      });
    } else {
      const chain = [];
      const visited = new Set();
      let current = mapping[conversation?.current_node];
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        chain.push(current);
        current = current.parent ? mapping[current.parent] : null;
      }
      nodes = chain.reverse().filter(node => node?.message);
    }
    return nodes.map(normalizeMappingNode).filter(Boolean).map((message, index) => ({ ...message, index: index + 1 }));
  };

  const formatLocalDate = iso => {
    if (!iso) return 'Время недоступно';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'Время недоступно';
    return `${date.toLocaleString('ru-RU')} (${Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'})`;
  };

  const fenced = value => `\n\`\`\`text\n${cleanText(value)}\n\`\`\`\n`;

  const toMarkdown = (data, options = {}) => {
    const settings = { reasoning: true, sources: true, tools: true, timestamps: true, ...options };
    const c = data.conversation || {};
    const out = [
      `# ${c.project_title ? `${c.project_title} — ` : ''}${c.title || 'ChatGPT Conversation'}`,
      '',
      '## Информация об экспорте',
      '',
      `- Версия экспортёра: ${data.exporter?.version || VERSION}`,
      `- URL разговора: ${c.url || 'недоступен'}`,
      `- Дата экспорта: ${data.exporter?.exported_at || new Date().toISOString()}`,
      `- Режим получения: ${c.acquisition_mode || 'unknown'}`,
      `- Ветка: ${c.branch_mode || 'current'}`,
      `- Сообщений: ${data.messages?.length || 0}`
    ];
    if (c.project_title) out.push(`- Проект: ${c.project_title}`);
    if (asArray(data.warnings).length) {
      out.push('', '## Предупреждения', '');
      asArray(data.warnings).forEach(item => out.push(`- ${item}`));
    }
    for (const message of asArray(data.messages)) {
      const role = String(message.role || 'unknown').toUpperCase();
      const time = settings.timestamps ? ` — ${message.created_at || 'время недоступно'}` : '';
      out.push('', '---', '', `## ${message.index}. ${role}${time}`, '');
      if (settings.timestamps) {
        out.push(`- Локальное время: ${formatLocalDate(message.created_at)}`);
        out.push(`- ISO: ${message.created_at || 'Время недоступно'}`);
        if (message.updated_at) out.push(`- Изменено: ${message.updated_at}`);
        if (message.id) out.push(`- Message ID: \`${message.id}\``);
        if (message.parent_id) out.push(`- Parent ID: \`${message.parent_id}\``);
        out.push('');
      }
      if (settings.reasoning && message.visible_reasoning) {
        out.push('### Видимое размышление / сводка рассуждений', '', message.visible_reasoning, '');
      }
      out.push(role === 'ASSISTANT' ? '### Ответ' : '### Сообщение', '', message.markdown || message.text || '', '');
      if (settings.sources && message.sources?.length) {
        out.push('### Источники', '');
        message.sources.forEach((source, index) => {
          out.push(`${index + 1}. [${source.title || source.url}](${source.url})${source.domain ? ` — ${source.domain}` : ''}`);
          if (source.cited_text) out.push(`   - Фрагмент: ${source.cited_text}`);
        });
        out.push('');
      }
      if (settings.tools && message.tool_calls?.length) {
        out.push('### Инструменты', '');
        message.tool_calls.forEach((tool, index) => {
          out.push(`#### ${index + 1}. ${tool.name}`);
          out.push(`- Статус: ${tool.status || 'unknown'}`);
          if (tool.input) out.push('- Вход:', fenced(tool.input));
          if (tool.output) out.push('- Результат:', fenced(tool.output));
        });
        out.push('');
      }
      if (message.attachments?.length) {
        out.push('### Вложения', '');
        message.attachments.forEach(file => out.push(`- ${file.saved_name ? `[${file.original_name}](${encodeURI(file.saved_name)})` : file.original_name}`));
        out.push('');
      }
    }
    return `${out.join('\n').replace(/\n{4,}/g, '\n\n\n')}\n`;
  };

  const toUnavailableFilesMarkdown = items => {
    const files = asArray(items);
    const lines = [
      '# Недоступные вложения ChatGPT',
      '',
      'Эти вложения были обнаружены в структуре разговора, но сервер ChatGPT запретил получить их содержимое.',
      'Экспортёр сохраняет исходные имена и метаданные; содержимое файла не подменяется пустым или диагностическим файлом.',
      ''
    ];
    files.forEach((file, index) => {
      lines.push(`## ${index + 1}. ${file.original_name || 'Без имени'}`);
      lines.push('');
      lines.push(`- Message ID: ${file.message_id || 'неизвестен'}`);
      lines.push(`- Роль: ${file.role || 'неизвестна'}`);
      lines.push(`- File ID: ${file.id || 'неизвестен'}`);
      if (file.mime_type) lines.push(`- MIME: ${file.mime_type}`);
      if (file.size) lines.push(`- Размер: ${file.size} байт`);
      lines.push(`- Причина: ${file.reason || 'HTTP 403'}`);
      lines.push('');
    });
    return lines.join('\n');
  };

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      table[i] = value >>> 0;
    }
    return table;
  })();

  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  const concatBytes = chunks => {
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  };

  const dosDateTime = date => {
    const value = date instanceof Date ? date : new Date();
    const year = Math.max(1980, value.getFullYear());
    return {
      time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate()
    };
  };

  const createStoredZip = entries => {
    const locals = [];
    const centrals = [];
    let offset = 0;
    const stamp = dosDateTime(new Date());
    for (const entry of entries) {
      const name = encoder.encode(String(entry.name).replace(/\\/g, '/'));
      const data = entry.data instanceof Uint8Array ? entry.data : encoder.encode(String(entry.data ?? ''));
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, stamp.time, true);
      view.setUint16(12, stamp.date, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true);
      local.set(name, 30);
      locals.push(local, data);

      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);
      centrals.push(central);
      offset += local.length + data.length;
    }
    const centralData = concatBytes(centrals);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralData.length, true);
    ev.setUint32(16, offset, true);
    return concatBytes([...locals, centralData, end]);
  };

  const localDate = () => {
    const date = new Date();
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };

  const htmlToMarkdown = root => {
    const convert = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName.toLowerCase();
      const inner = [...node.childNodes].map(convert).join('');
      if (/^h[1-6]$/.test(tag)) return `\n${'#'.repeat(Number(tag[1]))} ${cleanText(inner)}\n`;
      if (tag === 'p' || tag === 'div' || tag === 'section') return `\n${inner}\n`;
      if (tag === 'br') return '\n';
      if (tag === 'strong' || tag === 'b') return `**${inner}**`;
      if (tag === 'em' || tag === 'i') return `*${inner}*`;
      if (tag === 'code' && node.parentElement?.tagName.toLowerCase() !== 'pre') return `\`${inner}\``;
      if (tag === 'pre') return `\n\`\`\`\n${node.innerText || inner}\n\`\`\`\n`;
      if (tag === 'a') return `[${cleanText(inner) || node.href}](${node.href})`;
      if (tag === 'li') return `\n- ${inner}`;
      if (tag === 'blockquote') return `\n${cleanText(inner).split('\n').map(line => `> ${line}`).join('\n')}\n`;
      if (tag === 'table') return `\n${node.innerText}\n`;
      return inner;
    };
    return cleanText(convert(root));
  };

  const detectProjectTitle = (structured, doc = document, projectId = getProjectId(location.href)) => {
    const direct = cleanText(
      structured?.project_title || structured?.project?.title || structured?.project?.name ||
      structured?.workspace?.title || structured?.metadata?.project_title || ''
    );
    if (direct) return direct;
    const escapedProjectId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(projectId) : projectId.replace(/[^a-z0-9_-]/gi, '');
    const selectors = [
      '[data-testid="project-name"]', '[data-project-name]',
      '[data-testid*="project-title"]', '[aria-label*="Project"] [data-testid*="title"]',
      escapedProjectId ? `a[href^="/g/${escapedProjectId}"][href$="/project"]` : '',
      escapedProjectId ? `a[href*="/${escapedProjectId}-"][href$="/project"]` : ''
    ];
    for (const selector of selectors) {
      if (!selector) continue;
      const element = doc.querySelector(selector);
      const value = cleanText(element?.getAttribute('data-project-name') || element?.innerText || element?.textContent || '');
      if (value && !/^chatgpt$/i.test(value)) return value;
    }
    return '';
  };

  const detectProjectTitleAsync = async structured => {
    const immediate = detectProjectTitle(structured);
    if (immediate) return immediate;
    const projectId = getProjectId(location.href) || cleanText(structured?.gizmo_id || structured?.project_id || '');
    if (!projectId) return '';
    const endpoints = [
      `/backend-api/gizmos/${encodeURIComponent(projectId)}`,
      `/backend-api/projects/${encodeURIComponent(projectId)}`
    ];
    let context = structured?.[API_CONTEXT] || null;
    if (!context) {
      try { context = await getChatGptApiContext(); } catch (_) {}
    }
    const requestHeaders = context ? buildChatGptHeaders(context) : { Accept: 'application/json' };
    const fetchFn = context?.fetchFn || fetch;
    for (const endpoint of endpoints) {
      try {
        const response = await fetchFn(endpoint, { credentials: 'include', cache: 'no-store', headers: requestHeaders });
        if (!response.ok) continue;
        const payload = await response.json();
        const title = cleanText(payload?.display?.name || payload?.name || payload?.title || payload?.project?.name || payload?.project?.title || '');
        if (title) return title;
      } catch (_) {}
    }
    return '';
  };

  const detectTitle = (structured, doc = document) => cleanText(
    structured?.title ||
    doc.querySelector('main h1')?.textContent ||
    doc.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '') ||
    'ChatGPT Conversation'
  );

  const getStructuredConversation = async (conversationId, options = {}) => {
    if (!conversationId) throw new Error('В URL не найден идентификатор разговора.');
    const context = options.apiContext || await getChatGptApiContext(options);
    const fetchFn = options.fetchFn || context.fetchFn || fetch;
    const headers = buildChatGptHeaders(context);
    const urls = [
      `/backend-api/conversation/${encodeURIComponent(conversationId)}`,
      `/backend-api/conversations/${encodeURIComponent(conversationId)}?include_full_conversation=true`,
      `/api/conversation/${encodeURIComponent(conversationId)}`
    ];
    const failures = [];
    for (const url of urls) {
      try {
        const response = await fetchFn(url, { credentials: 'include', cache: 'no-store', headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data?.mapping) throw new Error('ответ не содержит дерево mapping');
        Object.defineProperty(data, API_CONTEXT, { value: context, enumerable: false });
        return data;
      } catch (error) {
        failures.push(`${url}: ${error?.message || error}`);
      }
    }
    throw new Error(failures.join('; '));
  };

  const findScroller = () => {
    let element = document.querySelector('[data-message-author-role]');
    while (element && element !== document.body) {
      const style = getComputedStyle(element);
      if (element.scrollHeight > element.clientHeight + 100 && ['auto', 'scroll'].includes(style.overflowY)) return element;
      element = element.parentElement;
    }
    return document.scrollingElement;
  };

  const collectDomConversation = async progress => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const saved = new Map();
    const scroller = findScroller();
    if (!scroller) throw new Error('Не найдена прокручиваемая область разговора.');
    const isDocument = scroller === document.scrollingElement;
    const getTop = () => isDocument ? window.scrollY : scroller.scrollTop;
    const getMax = () => isDocument ? document.documentElement.scrollHeight - window.innerHeight : scroller.scrollHeight - scroller.clientHeight;
    const height = () => isDocument ? window.innerHeight : scroller.clientHeight;
    const setTop = value => isDocument ? window.scrollTo(0, value) : (scroller.scrollTop = value);
    const oldTop = getTop();

    const collect = () => {
      document.querySelectorAll('[data-message-author-role]').forEach((element, index) => {
        const turn = element.closest('[data-testid^="conversation-turn-"]') || element.parentElement;
        const id = element.getAttribute('data-message-id') || turn?.getAttribute('data-testid') || `${element.getAttribute('data-message-author-role')}-${index}-${cleanText(element.innerText).slice(0, 80)}`;
        const markdownRoot = element.querySelector('.markdown, [class*="markdown"]') || element;
        const links = [...element.querySelectorAll('a[href]')];
        const sources = uniqueBy(links.map(link => normalizeSource({ title: cleanText(link.innerText) || link.href, url: link.href })).filter(Boolean), item => item.url);
        const linkAttachments = links.filter(link => link.hasAttribute('download') || /\/files?\//i.test(link.href)).map(link => normalizeAttachment({ name: link.getAttribute('download') || link.innerText || 'attachment', url: link.href })).filter(Boolean);
        const cardAttachments = collectVisibleFileCards(turn || element, id, element.getAttribute('data-message-author-role') || 'unknown');
        const attachments = uniqueBy([...linkAttachments, ...cardAttachments], item => item.id || item.source_url || `${id}:${item.original_name}`);
        const reasoningElement = turn?.querySelector('[data-testid*="reasoning"], [class*="reasoning"], details');
        const toolElements = [...(turn?.querySelectorAll('[data-testid*="tool"], [class*="tool-call"]') || [])];
        saved.set(id, {
          id, parent_id: null,
          role: element.getAttribute('data-message-author-role') || 'unknown',
          created_at: element.querySelector('time')?.dateTime || turn?.querySelector('time')?.dateTime || null,
          updated_at: null, model: null, content_type: 'dom',
          text: cleanText(element.innerText), markdown: htmlToMarkdown(markdownRoot),
          content_parts: [],
          visible_reasoning: reasoningElement ? cleanText(reasoningElement.innerText) : null,
          sources,
          tool_calls: toolElements.map(tool => normalizeToolCall({ name: tool.getAttribute('data-testid') || 'Инструмент', status: 'visible', output: tool.innerText })).filter(Boolean),
          attachments,
          raw_metadata: { acquisition: 'dom' }
        });
      });
      progress?.({ stage: 'Чтение отображаемых сообщений', found: saved.size });
    };

    setTop(0);
    await sleep(700);
    collect();
    for (let i = 0; i < 3000 && !progress?.stopped?.(); i += 1) {
      const current = getTop();
      const max = getMax();
      const next = Math.min(current + Math.max(320, height() * 0.7), max);
      setTop(next);
      await sleep(120);
      collect();
      if (next >= max - 5) {
        await sleep(500);
        collect();
        if (getMax() <= max + 5) break;
      }
    }
    setTop(oldTop);
    return [...saved.values()].map((message, index) => ({ ...message, index: index + 1 }));
  };

  const defaultSettings = {
    reasoning: true,
    sources: true,
    tools: true,
    timestamps: true,
    files: true,
    format: 'both',
    branchMode: 'current',
    zip: true
  };

  const loadSettings = () => {
    try { return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
    catch (_) { return { ...defaultSettings }; }
  };

  const saveSettings = settings => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
  };

  const styleButton = (button, primary = false) => Object.assign(button.style, {
    border: '0', borderRadius: '9px', padding: '10px 14px', cursor: 'pointer',
    fontWeight: '750', background: primary ? '#78d5de' : '#26343a',
    color: primary ? '#071014' : '#f3f7f8', boxShadow: primary ? '0 8px 24px rgba(42,180,194,.22)' : 'none'
  });

  const createShell = () => {
    const backdrop = document.createElement('div');
    backdrop.id = 'chatgpt-exporter-v2-backdrop';
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646',
      background: 'radial-gradient(circle at 20% 10%,rgba(19,150,170,.18),transparent 35%),rgba(4,7,10,.82)',
      backdropFilter: 'blur(8px)', display: 'grid', placeItems: 'center', padding: '18px',
      fontFamily: '"Segoe UI Variable Text","Trebuchet MS",sans-serif'
    });
    const panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    Object.assign(panel.style, {
      width: 'min(640px, 96vw)', maxHeight: '92vh', overflow: 'auto',
      background: 'linear-gradient(155deg,#111a20 0%,#0a1015 60%,#10171a 100%)',
      color: '#f3f7f8', border: '1px solid rgba(121,213,222,.38)', borderRadius: '18px', padding: '22px',
      boxShadow: '0 28px 90px rgba(0,0,0,.68),inset 0 1px rgba(255,255,255,.06)',
      letterSpacing: '.01em'
    });
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    return { backdrop, panel };
  };

  const askSettings = () => new Promise(resolve => {
    const settings = loadSettings();
    const { backdrop, panel } = createShell();
    panel.innerHTML = `
      <div style="color:#78d5de;font:700 11px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.18em;text-transform:uppercase;margin-bottom:8px">Local archive instrument · v2.0</div>
      <h2 style="margin:0 0 7px;font:600 27px/1.08 Georgia,serif;letter-spacing:-.02em">Экспорт разговора ChatGPT</h2>
      <div style="color:#aebbc0;margin-bottom:18px;line-height:1.45">Точный снимок доступной страницы. Переписка остаётся в браузере.</div>
      <fieldset style="border:1px solid #30434b;border-radius:12px;padding:13px 14px;margin:0 0 12px;background:rgba(255,255,255,.025)">
        <legend>Содержимое</legend>
        <label><input type="checkbox" name="reasoning"> Видимое размышление / сводка</label><br>
        <label><input type="checkbox" name="sources"> Источники и цитаты</label><br>
        <label><input type="checkbox" name="tools"> Вызовы инструментов</label><br>
        <label><input type="checkbox" name="timestamps"> Дата и время сообщений</label><br>
        <label><input type="checkbox" name="files"> Скачать доступные файлы</label>
      </fieldset>
      <fieldset style="border:1px solid #30434b;border-radius:12px;padding:13px 14px;margin:0 0 12px;background:rgba(255,255,255,.025)">
        <legend>Формат</legend>
        <label><input type="radio" name="format" value="markdown"> Markdown</label><br>
        <label><input type="radio" name="format" value="json"> JSON</label><br>
        <label><input type="radio" name="format" value="both"> Markdown + JSON</label>
      </fieldset>
      <fieldset style="border:1px solid #30434b;border-radius:12px;padding:13px 14px;margin:0 0 12px;background:rgba(255,255,255,.025)">
        <legend>Ветка разговора</legend>
        <label><input type="radio" name="branchMode" value="current"> Текущая видимая ветка</label><br>
        <label><input type="radio" name="branchMode" value="all"> Все обнаруженные варианты</label>
      </fieldset>
      <label style="display:block;margin:0 0 16px"><input type="checkbox" name="zip"> Создать единый ZIP</label>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button data-cancel>Отмена</button><button data-start>Начать экспорт</button></div>`;
    ['reasoning', 'sources', 'tools', 'timestamps', 'files', 'zip'].forEach(name => { panel.querySelector(`[name="${name}"]`).checked = Boolean(settings[name]); });
    panel.querySelector(`[name="format"][value="${settings.format}"]`).checked = true;
    panel.querySelector(`[name="branchMode"][value="${settings.branchMode}"]`).checked = true;
    const cancel = panel.querySelector('[data-cancel]');
    const start = panel.querySelector('[data-start]');
    styleButton(cancel); styleButton(start, true);
    cancel.onclick = () => { backdrop.remove(); resolve(null); };
    start.onclick = () => {
      const result = {
        reasoning: panel.querySelector('[name="reasoning"]').checked,
        sources: panel.querySelector('[name="sources"]').checked,
        tools: panel.querySelector('[name="tools"]').checked,
        timestamps: panel.querySelector('[name="timestamps"]').checked,
        files: panel.querySelector('[name="files"]').checked,
        zip: panel.querySelector('[name="zip"]').checked,
        format: panel.querySelector('[name="format"]:checked').value,
        branchMode: panel.querySelector('[name="branchMode"]:checked').value
      };
      saveSettings(result);
      backdrop.remove();
      resolve(result);
    };
  });

  const createProgress = () => {
    const { backdrop, panel } = createShell();
    panel.innerHTML = `
      <h2 style="margin:0 0 12px;font-size:20px">ChatGPT Exporter v${VERSION}</h2>
      <div data-stats style="white-space:pre-line;line-height:1.55">Подготовка...</div>
      <div data-stage style="margin:14px 0;color:#a1a1aa">Начинаю экспорт</div>
      <button data-stop>Остановить и сохранить найденное</button>`;
    const stats = panel.querySelector('[data-stats]');
    const stage = panel.querySelector('[data-stage]');
    const stop = panel.querySelector('[data-stop]');
    styleButton(stop);
    let stopped = false;
    stop.onclick = () => { stopped = true; stop.disabled = true; stop.textContent = 'Остановка запрошена…'; };
    return {
      update(data = {}) {
        if (data.stage) stage.textContent = data.stage;
        const lines = [];
        if (data.found !== undefined) lines.push(`Сообщений найдено: ${data.found}`);
        if (data.processed !== undefined) lines.push(`Сообщений обработано: ${data.processed}`);
        if (data.reasoning !== undefined) lines.push(`Размышлений: ${data.reasoning}`);
        if (data.sources !== undefined) lines.push(`Источников: ${data.sources}`);
        if (data.tools !== undefined) lines.push(`Вызовов инструментов: ${data.tools}`);
        if (data.filesFound !== undefined) lines.push(`Файлов найдено: ${data.filesFound}`);
        if (data.filesDone !== undefined) lines.push(`Файлов скачано: ${data.filesDone} из ${data.filesFound}`);
        if (lines.length) stats.textContent = lines.join('\n');
      },
      stopped: () => stopped,
      close: () => backdrop.remove()
    };
  };

  const resolveAttachmentUrl = attachment => {
    const source = attachment.source_url;
    if (!source) return '';
    if (/^https?:/i.test(source)) return source;
    if (source.startsWith('/')) return new URL(source, location.origin).href;
    return '';
  };

  const downloadAttachments = async (messages, progress, warnings, structured = null) => {
    const attachments = [];
    messages.forEach(message => message.attachments?.forEach(file => attachments.push({ message, file })));
    const entries = [];
    const unavailable = [];
    let completed = 0;
    for (let index = 0; index < attachments.length; index += 1) {
      if (progress.stopped()) break;
      const { message, file } = attachments[index];
      const conversationId = getConversationId(location.href) || structured?.id || '';
      const source = file.source_url || buildAttachmentDownloadUrl(file, message.id, conversationId);
      if (!file.source_url && source) file.source_url = source;
      const url = resolveAttachmentUrl({ ...file, source_url: source });
      file.saved_name = `files/${String(index + 1).padStart(3, '0')} - ${safeFileName(file.original_name, 'attachment')}`;
      try {
        if (!url) throw new Error('рабочая ссылка недоступна странице');
        const context = structured?.[API_CONTEXT] || null;
        const sameOrigin = (() => { try { return new URL(url, location.href).origin === location.origin; } catch (_) { return false; } })();
        const headers = sameOrigin && context ? buildChatGptHeaders(context) : undefined;
        let response = await (context?.fetchFn || fetch)(url, { credentials: 'include', headers });
        if (!response.ok && response.status === 403 && /^file_/i.test(file.id || '') && !file.sandbox_path) {
          const inlineUrl = new URL(url, location.href);
          inlineUrl.searchParams.delete('post_id');
          inlineUrl.searchParams.set('inline', 'true');
          inlineUrl.searchParams.set('download_intent', 'false');
          response = await (context?.fetchFn || fetch)(inlineUrl.href, { credentials: 'include', headers });
        }
        if (!response.ok) {
          const responseError = new Error(`HTTP ${response.status}`);
          responseError.status = response.status;
          throw responseError;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        file.status = 'downloaded';
        file.size = bytes.length;
        file.mime_type = file.mime_type || response.headers.get('content-type') || '';
        entries.push({ name: file.saved_name, data: bytes });
        completed += 1;
      } catch (error) {
        const isForbiddenUpload = error?.status === 403 && /^file_/i.test(file.id || '') && !file.sandbox_path;
        file.status = isForbiddenUpload ? 'unavailable' : 'failed';
        file.reason = error?.message || String(error);
        if (isForbiddenUpload) {
          file.reason_code = 'chatgpt_file_forbidden';
          file.reason = 'ChatGPT запретил доступ к пользовательскому вложению (HTTP 403); тот же запрет возвращает встроенная карточка файла.';
          unavailable.push({
            message_id: message.id,
            role: message.role || null,
            id: file.id || null,
            original_name: file.original_name,
            mime_type: file.mime_type || null,
            size: file.size || null,
            reason_code: file.reason_code,
            reason: file.reason
          });
        }
        warnings.push(`Файл «${file.original_name}» не скачан: ${file.reason}`);
      }
      progress.update({ stage: `Скачивание файлов: ${index + 1}/${attachments.length}`, filesFound: attachments.length, filesDone: completed });
    }
    return { entries, total: attachments.length, completed, unavailable };
  };

  const triggerDownload = (name, data, type) => {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const makeExportData = ({ structured, messages, title, projectTitle, settings, acquisitionMode, warnings }) => ({
    exporter: {
      name: 'ChatGPT Conversation Exporter',
      version: VERSION,
      exported_at: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null
    },
    conversation: {
      id: getConversationId(location.href) || structured?.id || null,
      title,
      project_title: projectTitle || null,
      url: location.href,
      current_node: structured?.current_node || null,
      branch_mode: settings.branchMode,
      acquisition_mode: acquisitionMode
    },
    options: settings,
    warnings,
    messages
  });

  const showResult = ({ filename, warnings, count, stopped }) => {
    const { backdrop, panel } = createShell();
    const title = document.createElement('h2');
    title.textContent = stopped ? 'Частичный экспорт сохранён' : 'Экспорт завершён';
    title.style.marginTop = '0';
    panel.appendChild(title);
    const info = document.createElement('div');
    info.textContent = `Сообщений: ${count}\nФайл: ${filename}`;
    info.style.whiteSpace = 'pre-line';
    panel.appendChild(info);
    if (warnings.length) {
      const details = document.createElement('details');
      details.style.marginTop = '12px';
      const summary = document.createElement('summary');
      summary.textContent = `Предупреждения: ${warnings.length}`;
      details.append(summary, document.createTextNode(`\n${warnings.join('\n')}`));
      panel.appendChild(details);
    }
    const close = document.createElement('button');
    close.textContent = 'Закрыть';
    close.style.marginTop = '16px';
    styleButton(close, true);
    close.onclick = () => backdrop.remove();
    panel.appendChild(close);
  };

  const run = async () => {
    if (window[RUN_KEY]) {
      alert('ChatGPT Conversation Exporter v2 уже запущен.');
      return;
    }
    if (!/(^|\.)chatgpt\.com$/i.test(location.hostname)) throw new Error('Откройте нужный разговор на chatgpt.com и запустите закладку снова.');
    window[RUN_KEY] = true;
    let progress = null;
    try {
      const settings = await askSettings();
      if (!settings) return;
      progress = createProgress();
      const warnings = [];
      let structured = null;
      let messages = [];
      let acquisitionMode = 'structured';
      try {
        progress.update({ stage: 'Получаю структурированное дерево разговора…' });
        structured = await getStructuredConversation(getConversationId(location.href));
        messages = selectMappingMessages(structured, settings.branchMode);
        if (!messages.length) throw new Error('структурированное дерево не содержит сообщений');
        enrichMessagesFromDom(messages);
      } catch (error) {
        acquisitionMode = 'dom';
        warnings.push(`Структурированный режим недоступен, использован DOM fallback: ${error?.message || error}`);
        progress.update({ stage: 'Структурированные данные недоступны. Читаю видимую страницу…' });
        messages = await collectDomConversation(Object.assign(data => progress.update(data), { stopped: progress.stopped }));
      }
      if (!messages.length) throw new Error('В разговоре не найдено сообщений.');

      if (!settings.reasoning) messages.forEach(message => { message.visible_reasoning = null; });
      if (!settings.sources) messages.forEach(message => { message.sources = []; });
      if (!settings.tools) messages.forEach(message => { message.tool_calls = []; });
      if (!settings.timestamps) messages.forEach(message => { message.created_at = null; message.updated_at = null; });

      const counts = {
        found: messages.length,
        processed: messages.length,
        reasoning: messages.filter(item => item.visible_reasoning).length,
        sources: messages.reduce((sum, item) => sum + item.sources.length, 0),
        tools: messages.reduce((sum, item) => sum + item.tool_calls.length, 0),
        filesFound: messages.reduce((sum, item) => sum + item.attachments.length, 0)
      };
      progress.update({ stage: 'Нормализация сообщений завершена', ...counts });

      const title = detectTitle(structured);
      const projectTitle = await detectProjectTitleAsync(structured);
      const exportBase = buildExportBaseName({ projectTitle, conversationTitle: title });
      const resultBase = safeFileName(`${exportBase} - ChatGPT Export v2 - ${localDate()}`);
      let attachmentResult = { entries: [], total: counts.filesFound, completed: 0, unavailable: [] };
      if (settings.files && counts.filesFound) attachmentResult = await downloadAttachments(messages, progress, warnings, structured);

      if (progress.stopped()) warnings.push('Экспорт остановлен пользователем; сохранены уже найденные данные.');
      const data = makeExportData({ structured, messages, title, projectTitle, settings, acquisitionMode, warnings });
      const manifest = {
        exporter: data.exporter,
        conversation: data.conversation,
        acquisition_mode: acquisitionMode,
        fallback_used: acquisitionMode === 'dom',
        partial: progress.stopped(),
        warnings,
        files: messages.flatMap(message => message.attachments.map(file => ({ message_id: message.id, ...file })))
      };

      const entries = [...attachmentResult.entries];
      if (attachmentResult.unavailable.length) {
        entries.push({ name: 'unavailable-files.md', data: encoder.encode(toUnavailableFilesMarkdown(attachmentResult.unavailable)) });
        entries.push({ name: 'unavailable-files.json', data: encoder.encode(JSON.stringify(attachmentResult.unavailable, null, 2)) });
      }
      if (settings.format === 'markdown' || settings.format === 'both') entries.unshift({ name: 'conversation.md', data: encoder.encode(toMarkdown(data, settings)) });
      if (settings.format === 'json' || settings.format === 'both') entries.unshift({ name: 'conversation.json', data: encoder.encode(JSON.stringify(data, null, 2)) });
      entries.push({ name: 'manifest.json', data: encoder.encode(JSON.stringify(manifest, null, 2)) });

      let finalName;
      if (settings.zip || entries.length > 1 || attachmentResult.entries.length) {
        finalName = `${resultBase}.zip`;
        progress.update({ stage: 'Создаю ZIP…', ...counts, filesDone: attachmentResult.completed });
        triggerDownload(finalName, createStoredZip(entries), 'application/zip');
      } else {
        const only = entries[0];
        finalName = `${resultBase}.${only.name.endsWith('.md') ? 'md' : 'json'}`;
        triggerDownload(finalName, only.data, only.name.endsWith('.md') ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8');
      }
      progress.close();
      showResult({ filename: finalName, warnings, count: messages.length, stopped: progress.stopped() });
    } catch (error) {
      progress?.close();
      throw error;
    } finally {
      delete window[RUN_KEY];
    }
  };

  return {
    VERSION,
    safeFileName,
    buildExportBaseName,
    getConversationId,
    getProjectId,
    getOwnerUserId,
    buildChatGptHeaders,
    getStructuredConversation,
    parseUiTimestampLabel,
    buildAttachmentDownloadUrl,
    downloadAttachments,
    toUnavailableFilesMarkdown,
    selectMappingMessages,
    normalizeMappingNode,
    toMarkdown,
    createStoredZip,
    run
  };
});
