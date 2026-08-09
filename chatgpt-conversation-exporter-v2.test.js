'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const sourcePath = path.join(__dirname, 'chatgpt-conversation-exporter-v2.js');
const core = require(sourcePath);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('строит имя проекта и чата', () => {
  assert.equal(
    core.buildExportBaseName({ projectTitle: 'Работа', conversationTitle: 'Отчёт за день' }),
    'Работа - Отчёт за день'
  );
});

test('для обычного чата использует только название чата', () => {
  assert.equal(
    core.buildExportBaseName({ projectTitle: '', conversationTitle: 'Новый чат' }),
    'Новый чат'
  );
});

test('удаляет запрещённые Windows-символы и точки на конце', () => {
  assert.equal(core.safeFileName('Проект: тест / чат?..  '), 'Проект_ тест _ чат_');
});

test('извлекает conversation id из обычного и проектного URL', () => {
  assert.equal(core.getConversationId('https://chatgpt.com/c/abc-123'), 'abc-123');
  assert.equal(core.getConversationId('https://chatgpt.com/g/g-test/c/xyz-987'), 'xyz-987');
});

test('извлекает project id только из проектного URL', () => {
  assert.equal(core.getProjectId('https://chatgpt.com/g/g-p-project123/c/xyz-987'), 'g-p-project123');
  assert.equal(
    core.getProjectId('https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-example-project/shared/c/xyz-987?owner_user_id=user-example'),
    'g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  assert.equal(core.getProjectId('https://chatgpt.com/c/abc-123'), '');
});

test('извлекает владельца общего проектного чата', () => {
  assert.equal(core.getOwnerUserId('https://chatgpt.com/g/g-p-123/shared/c/x?owner_user_id=user-example'), 'user-example');
  assert.equal(core.getOwnerUserId('https://chatgpt.com/c/x'), '');
});

test('строит приватные API-заголовки проекта без утечки в результат', () => {
  assert.deepEqual(core.buildChatGptHeaders({ accessToken: 'secret-token', projectId: 'g-p-123', ownerUserId: 'user-42' }), {
    Accept: 'application/json',
    Authorization: 'Bearer secret-token',
    'chatgpt-project-id': 'g-p-123',
    'chatgpt-conv-owner-id': 'user-42'
  });
});

test('структурированный запрос получает токен текущей сессии и mapping', async () => {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: 'secret-token' }) };
    assert.equal(options.headers.Authorization, 'Bearer secret-token');
    assert.equal(options.headers['chatgpt-project-id'], 'g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(options.headers['chatgpt-conv-owner-id'], 'user-example');
    return { ok: true, json: async () => ({ id: 'conversation-1', mapping: { root: { message: null } } }) };
  };
  const data = await core.getStructuredConversation('conversation-1', {
    fetchFn,
    pageUrl: 'https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-example-project/shared/c/conversation-1?owner_user_id=user-example'
  });
  assert.ok(data.mapping);
  assert.equal(JSON.stringify(data).includes('secret-token'), false);
  assert.equal(calls.length, 2);
});

test('разбирает русские метки времени из меню сообщения', () => {
  const now = new Date(2026, 7, 9, 12, 0, 0);
  assert.equal(core.parseUiTimestampLabel('сегодня, 0:17', now).getTime(), new Date(2026, 7, 9, 0, 17).getTime());
  assert.equal(core.parseUiTimestampLabel('вчера, 23:59', now).getTime(), new Date(2026, 7, 8, 23, 59).getTime());
  assert.equal(core.parseUiTimestampLabel('9 августа 2026 г., 0:17', now).getTime(), new Date(2026, 7, 9, 0, 17).getTime());
});

test('строит ссылки для загруженного и созданного в песочнице файла', () => {
  assert.equal(
    core.buildAttachmentDownloadUrl({ id: 'file_abc' }, 'message-1', 'conversation-1'),
    '/backend-api/files/download/file_abc?inline=false&download_intent=true'
  );
  assert.equal(
    core.buildAttachmentDownloadUrl({ sandbox_path: '/mnt/data/report.txt' }, 'message-1', 'conversation-1'),
    '/backend-api/conversation/conversation-1/interpreter/download?message_id=message-1&sandbox_path=%2Fmnt%2Fdata%2Freport.txt'
  );
});

test('скачивает sandbox-файл с идентификатором его сообщения', async () => {
  const previousFetch = global.fetch;
  const previousLocation = global.location;
  const requestedUrls = [];
  global.location = { href: 'https://chatgpt.com/c/conversation-1', origin: 'https://chatgpt.com' };
  global.fetch = async url => {
    requestedUrls.push(url);
    return {
      ok: true,
      arrayBuffer: async () => Uint8Array.from([111, 107]).buffer,
      headers: { get: () => 'text/plain' }
    };
  };
  const progress = { stopped: () => false, update: () => {} };
  const warnings = [];
  const messages = [{
    id: 'message-1',
    attachments: [{ original_name: 'report.txt', source_url: '', sandbox_path: '/mnt/data/report.txt', status: 'pending' }]
  }];
  try {
    const result = await core.downloadAttachments(messages, progress, warnings);
    assert.equal(result.completed, 1);
    assert.equal(warnings.length, 0);
    assert.match(requestedUrls[0], /message_id=message-1/);
  } finally {
    global.fetch = previousFetch;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
});

test('после 403 пробует официальный inline-маршрут пользовательского файла', async () => {
  const previousFetch = global.fetch;
  const previousLocation = global.location;
  const requestedUrls = [];
  global.location = { href: 'https://chatgpt.com/c/conversation-1', origin: 'https://chatgpt.com' };
  global.fetch = async url => {
    requestedUrls.push(url);
    if (requestedUrls.length === 1) return { ok: false, status: 403, headers: { get: () => 'application/json' } };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from([111, 107]).buffer,
      headers: { get: () => 'text/plain' }
    };
  };
  const file = {
    id: 'file_abc', original_name: 'upload.txt',
    source_url: '/backend-api/files/download/file_abc?inline=false&download_intent=true',
    sandbox_path: null, status: 'pending'
  };
  try {
    const result = await core.downloadAttachments([{ id: 'message-1', role: 'user', attachments: [file] }], { stopped: () => false, update: () => {} }, []);
    assert.equal(result.completed, 1);
    assert.equal(requestedUrls.length, 2);
    assert.match(requestedUrls[1], /inline=true&download_intent=false/);
    assert.equal(file.status, 'downloaded');
  } finally {
    global.fetch = previousFetch;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
});

test('двойной 403 помечает файл как недоступный и возвращает его в отчёте', async () => {
  const previousFetch = global.fetch;
  const previousLocation = global.location;
  global.location = { href: 'https://chatgpt.com/c/conversation-1', origin: 'https://chatgpt.com' };
  global.fetch = async () => ({ ok: false, status: 403, headers: { get: () => 'application/json' } });
  const file = {
    id: 'file_forbidden', original_name: 'private.txt', size: 123,
    source_url: '/backend-api/files/download/file_forbidden?inline=false&download_intent=true',
    sandbox_path: null, status: 'pending'
  };
  try {
    const result = await core.downloadAttachments([{ id: 'message-7', role: 'user', attachments: [file] }], { stopped: () => false, update: () => {} }, []);
    assert.equal(result.completed, 0);
    assert.equal(result.unavailable.length, 1);
    assert.equal(result.unavailable[0].message_id, 'message-7');
    assert.equal(result.unavailable[0].original_name, 'private.txt');
    assert.equal(file.status, 'unavailable');
    assert.equal(file.reason_code, 'chatgpt_file_forbidden');
  } finally {
    global.fetch = previousFetch;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
});

test('формирует читаемый отчёт о недоступных серверных вложениях', () => {
  const report = core.toUnavailableFilesMarkdown([{
    message_id: 'message-7', role: 'user', id: 'file_forbidden',
    original_name: 'private.txt', size: 123,
    reason: 'ChatGPT запретил доступ к пользовательскому вложению (HTTP 403).'
  }]);
  assert.match(report, /private\.txt/);
  assert.match(report, /message-7/);
  assert.match(report, /HTTP 403/);
  assert.match(report, /содержимое файла не подменяется/i);
});

const mappingFixture = {
  current_node: 'a2',
  mapping: {
    root: { id: 'root', parent: null, children: ['u1'], message: null },
    u1: {
      id: 'u1', parent: 'root', children: ['a1', 'a2'],
      message: { id: 'u1', author: { role: 'user' }, create_time: 10, content: { content_type: 'text', parts: ['Вопрос'] }, metadata: {} }
    },
    a1: {
      id: 'a1', parent: 'u1', children: [],
      message: { id: 'a1', author: { role: 'assistant' }, create_time: 11, content: { content_type: 'text', parts: ['Старый ответ'] }, metadata: {} }
    },
    a2: {
      id: 'a2', parent: 'u1', children: [],
      message: { id: 'a2', author: { role: 'assistant' }, create_time: 12, content: { content_type: 'text', parts: ['Текущий ответ'] }, metadata: {} }
    }
  }
};

test('текущая ветка не включает альтернативный ответ', () => {
  const messages = core.selectMappingMessages(mappingFixture, 'current');
  assert.deepEqual(messages.map(item => item.id), ['u1', 'a2']);
});

test('режим всех веток сохраняет оба варианта', () => {
  const messages = core.selectMappingMessages(mappingFixture, 'all');
  assert.deepEqual(messages.map(item => item.id), ['u1', 'a1', 'a2']);
});

test('Markdown сохраняет полный текст, время, источники и инструменты', () => {
  const md = core.toMarkdown({
    exporter: { version: '2.0', exported_at: '2026-08-09T00:00:00.000Z' },
    conversation: { title: 'Тест', project_title: 'Проект', url: 'https://chatgpt.com/c/x', acquisition_mode: 'structured' },
    messages: [{
      index: 1, role: 'assistant', created_at: '2026-08-09T00:00:00.000Z', text: 'Полный **ответ**',
      visible_reasoning: 'Краткая сводка',
      sources: [{ title: 'Документация', url: 'https://example.com/doc' }],
      tool_calls: [{ name: 'web.run', status: 'finished', input: 'поиск', output: 'найдено' }],
      attachments: []
    }]
  }, { reasoning: true, sources: true, tools: true, timestamps: true });
  assert.match(md, /Полный \*\*ответ\*\*/);
  assert.match(md, /Видимое размышление/);
  assert.match(md, /https:\/\/example\.com\/doc/);
  assert.match(md, /web\.run/);
  assert.match(md, /2026-08-09T00:00:00\.000Z/);
});

test('ZIP имеет сигнатуры локального файла и центрального каталога', () => {
  const zip = core.createStoredZip([{ name: 'test.txt', data: new TextEncoder().encode('ok') }]);
  assert.equal(new DataView(zip.buffer, zip.byteOffset, zip.byteLength).getUint32(0, true), 0x04034b50);
  const text = Buffer.from(zip).toString('latin1');
  assert.ok(text.includes('test.txt'));
  assert.ok(text.includes('PK\x05\x06'));
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log(`PASS ${item.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${item.name}`);
      console.error(error.stack || error);
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`PASS ${tests.length}/${tests.length}`);
})();
