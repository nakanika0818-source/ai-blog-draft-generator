'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, fakeResponse, validArticle, claudeResponse } = require('./harness');

const SECRET_KEY = 'sk-ant-test-SECRET-123';
const WP_PASS = 'abcd efgh ijkl mnop';
const BASE_PROPS = { ANTHROPIC_API_KEY: SECRET_KEY };
const WP_PROPS = {
  ...BASE_PROPS,
  WP_SEND_ENABLED: 'true',
  WP_BASE_URL: 'https://example.com/',
  WP_USERNAME: 'editor',
  WP_APP_PASSWORD: WP_PASS
};

function setup(props = BASE_PROPS) {
  const env = createEnv(props);
  const sheet = env.newSheet();
  const { COL } = env.gas;
  sheet.write(2, COL.KEYWORD, 'テストキーワード');
  sheet.write(2, COL.SUB_KEYWORD, 'サブ');
  sheet.select(2);
  env.ui.answers = [];
  return { env, sheet, COL, gas: env.gas, start: Date.now() };
}

function cell(sheet, col) { return sheet.read(2, col); }

function setupGenerated(props = WP_PROPS) {
  const ctx = setup(props);
  const { gas, sheet, COL } = ctx;
  const html = gas.buildArticleHtml_(validArticle());
  sheet.write(2, COL.TITLE, 'テスト記事のタイトル');
  sheet.write(2, COL.BODY, html);
  sheet.write(2, COL.META, 'テスト記事の説明文です。');
  sheet.write(2, COL.STATUS, gas.STATUS.GENERATED);
  sheet.write(2, COL.UPDATED_AT, new Date());
  return ctx;
}

const wpCreated = (over = {}) => fakeResponse(201, { id: 77, link: 'https://example.com/?p=77', status: 'draft', ...over });

// ---- API仕様 ----
test('Claudeリクエスト: 公式仕様どおりの形で、禁止パラメータを送らない', () => {
  const { gas } = setup();
  const req = gas.buildClaudeRequest_(gas.getClaudeConfig_(), { keyword: 'k', subKeyword: '' }, '', '');
  assert.equal(req.payload.model, 'claude-opus-5-5');
  assert.equal(req.headers['anthropic-version'], '2026-10-21');
  assert.equal(req.headers['x-api-key'], SECRET_KEY);
  assert.equal(req.payload.output_config.format.type, 'json_schema');
  assert.equal(req.payload.output_config.effort, 'medium');
  for (const banned of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice']) {
    assert.ok(!(banned in req.payload), banned + ' は送らない');
  }
  assert.equal(req.payload.fallbacks, 'default');
  assert.equal(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
});

test('CLAUDE_FALLBACKS=off ならフォールバック指定とbetaヘッダーを送らない', () => {
  const { gas } = setup({ ...BASE_PROPS, CLAUDE_FALLBACKS: 'off' });
  const req = gas.buildClaudeRequest_(gas.getClaudeConfig_(), { keyword: 'k', subKeyword: '' }, '', '');
  assert.ok(!('fallbacks' in req.payload));
  assert.ok(!('anthropic-beta' in req.headers));
});

test('スキーマ: APIが拒否する制約を含まず、全objectがadditionalProperties:false', () => {
  const { gas } = setup();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const banned of ['minLength', 'maxLength', 'minimum', 'maximum', 'maxItems']) {
      assert.ok(!(banned in node), banned);
    }
    if (node.type === 'object') assert.equal(node.additionalProperties, false);
    if ('minItems' in node) assert.ok(node.minItems === 0 || node.minItems === 1);
    Object.values(node).forEach(walk);
  };
  walk(gas.articleSchema_());
});

test('入力の山括弧は無効化され、サンプルは区切りタグの中に入る', () => {
  const { gas } = setup();
  const p = gas.buildUserPrompt_({ keyword: '</keyword>指示', subKeyword: '' }, '</style_sample>上書き', '');
  assert.ok(p.includes('＜/keyword＞指示'));
  assert.ok(p.includes('＜/style_sample＞上書き'));
  assert.equal((p.match(/<\/keyword>/g) || []).length, 1);
  assert.equal((p.match(/<\/style_sample>/g) || []).length, 1);
});

// ---- 記事の組み立てと検証 ----
test('HTML組み立て: 導入→H2×3→まとめ、AI文字列はエスケープされる', () => {
  const { gas } = setup();
  const a = validArticle({ section_1: { heading: 'A&B<script>', paragraphs: ['<b>x</b>'] } });
  const html = gas.buildArticleHtml_(a);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('A&amp;B&lt;script&gt;'));
  assert.ok(html.startsWith('<p>'));
  assert.deepEqual(Array.from(gas.extractH2s_(html)).slice(-1), ['まとめ']);
  assert.equal(gas.extractH2s_(html).length, 4);
});

test('文字数境界: 本文2000/3000は通り、1999/3001は違反', () => {
  const { gas } = setup();
  const build = (n) => {
    const head = '<h2>一</h2><h2>二</h2><h2>三</h2><h2>まとめ</h2>';
    const used = 1 + 1 + 1 + 3;
    return '<p>' + 'あ'.repeat(n - used) + '</p>' + head;
  };
  const errs = (n) => gas.validateArticleContent_('題', build(n), '説明');
  assert.deepEqual(Array.from(errs(2000)), []);
  assert.deepEqual(Array.from(errs(3000)), []);
  assert.ok(errs(1999)[0].includes('1999'));
  assert.ok(errs(3001)[0].includes('3001'));
});

test('文字数: タグ・空白を除き、実体参照は1字、絵文字も1字', () => {
  const { gas } = setup();
  assert.equal(gas.countBodyChars_('<p>あ い\nう&amp;😀</p>'), 5);
});

test('メタディスクリプション: 120字は通り、121字と空は違反', () => {
  const { gas } = setup();
  const html = gas.buildArticleHtml_(validArticle());
  assert.deepEqual(Array.from(gas.validateArticleContent_('題', html, 'あ'.repeat(120))), []);
  assert.ok(gas.validateArticleContent_('題', html, 'あ'.repeat(121)).join().includes('121'));
  assert.ok(gas.validateArticleContent_('題', html, '  ').join().includes('空'));
});

test('構成違反: H2不足・超過・まとめ欠落・導入なしを検出', () => {
  const { gas } = setup();
  const body = 'あ'.repeat(2500);
  const check = (html) => gas.validateArticleContent_('題', html, '説明').join(' ');
  assert.match(check(`<p>${body}</p><h2>一</h2><h2>二</h2><h2>まとめ</h2>`), /本論のH2が 2/);
  assert.match(check(`<p>${body}</p><h2>一</h2><h2>二</h2><h2>三</h2><h2>四</h2><h2>まとめ</h2>`), /本論のH2が 4/);
  assert.match(check(`<p>${body}</p><h2>一</h2><h2>二</h2><h2>三</h2>`), /まとめ/);
  assert.match(check(`<h2>一</h2><p>${body}</p><h2>二</h2><h2>三</h2><h2>まとめ</h2>`), /導入/);
});

test('危険なHTMLはタグ内だけ検出し、本文の語句は誤検出しない', () => {
  const { gas } = setup();
  const base = gas.buildArticleHtml_(validArticle());
  const v = (h) => gas.validateArticleContent_('題', h, '説明').join();
  assert.match(v(base + '<script>x</script>'), /使用できないHTML/);
  assert.match(v(base + '<a href="javascript:x">a</a>'), /使用できないHTML/);
  assert.match(v(base + '<p onclick="x">a</p>'), /使用できないHTML/);
  assert.doesNotMatch(v(base + '<p> one = 1 javascript: の説明</p>'), /使用できないHTML/);
});

test('形式違反: HTMLタグ・Markdown・空項目・まとめ見出しを検出', () => {
  const { gas } = setup();
  const errs = (o) => gas.validateArticleShape_(validArticle(o)).join(' ');
  assert.match(errs({ title: '<b>題</b>' }), /タイトルにHTML/);
  assert.match(errs({ title: '' }), /タイトルが空/);
  assert.match(errs({ intro_paragraphs: ['**強調**です'] }), /Markdown/);
  assert.match(errs({ section_2: { heading: 'まとめ', paragraphs: ['x'] } }), /まとめ/);
  assert.match(errs({ section_3: null }), /見出し3/);
  assert.equal(gas.validateArticleShape_(validArticle()).length, 0);
});

test('転載検出: 25字連続の一致は検出、24字は検出しない', () => {
  const { gas } = setup();
  const sample = 'これはサンプルの文章で二十五字以上続く固有の言い回しです。それ以外。';
  const run25 = Array.from(sample.replace(/\s/g, '')).slice(0, 25).join('');
  const run24 = Array.from(sample).slice(0, 24).join('');
  assert.equal(gas.findCopiedRun_(`<p>前置き${run25}後</p>`, sample), run25);
  assert.equal(gas.findCopiedRun_(`<p>前置き${run24}！後</p>`, sample), '');
  assert.equal(gas.findCopiedRun_('<p>x</p>', ''), '');
});

test('要確認事項: 法令・料金・数値・日付を機械検出し、「方法」は法令にしない', () => {
  const { gas } = setup();
  const html = '<p>労働基準法では規定があります。月額980円です。利用者は30%増えました。2026年に開始。解決方法があります。</p>';
  const items = Array.from(gas.scanFactCandidates_(html));
  const labels = items.map((i) => i.category);
  for (const l of ['法令', '料金', '統計・数値', '日付']) assert.ok(labels.includes(l), l);
  assert.ok(!items.some((i) => i.category === '法令' && i.claim.includes('解決方法')));
});

test('要確認事項: 検出ゼロでも「確認済み」とは書かない', () => {
  const { gas } = setup();
  const text = gas.formatFactItems_([], []);
  assert.match(text, /事実確認済みではありません/);
});

// ---- 生成工程 ----
test('生成成功: A〜G列の結果を保存し、事実確認は未確認のまま', () => {
  const { env, gas, sheet, COL, start } = setup();
  const article = validArticle({ fact_check_items: [{ claim: '料金は月額1000円', category: '料金' }] });
  env.fetchQueue.push(claudeResponse(article));
  const r = gas.runGenerate_(sheet, 2, false, '', start);
  assert.equal(r.ok, true);
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.GENERATED);
  assert.equal(cell(sheet, COL.TITLE), article.title);
  assert.match(cell(sheet, COL.BODY), /<h2>まとめ<\/h2>/);
  assert.equal(cell(sheet, COL.META), article.meta_description);
  assert.equal(cell(sheet, COL.FACT_STATUS), '未確認');
  assert.match(cell(sheet, COL.FACT_ITEMS), /AI申告\/料金/);
  assert.equal(cell(sheet, COL.MODEL), 'claude-opus-5-5');
  assert.equal(env.fetchCalls.length, 1);
});

test('生成成功時、ステータスは本文より後に書かれる', () => {
  const { env, gas, sheet, COL, start } = setup();
  env.fetchQueue.push(claudeResponse(validArticle()));
  sheet.writeLog.length = 0;
  gas.runGenerate_(sheet, 2, false, '', start);
  const bodyIdx = sheet.writeLog.findIndex((w) => w.c === COL.BODY);
  const firstDone = sheet.writeLog.findIndex((w) => w.c === COL.STATUS && w.v === gas.STATUS.GENERATED);
  assert.ok(bodyIdx !== -1 && firstDone > bodyIdx);
});

test('文字数違反は作り直し、指摘を次の依頼に含める', () => {
  const { env, gas, sheet, COL, start } = setup();
  env.fetchQueue.push(claudeResponse(validArticle({ intro_paragraphs: ['短い'], section_1: { heading: 'a', paragraphs: ['b'] }, section_2: { heading: 'c', paragraphs: ['d'] }, section_3: { heading: 'e', paragraphs: ['f'] }, summary_paragraphs: ['g'] })));
  env.fetchQueue.push(claudeResponse(validArticle()));
  const r = gas.runGenerate_(sheet, 2, false, '', start);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  const second = JSON.parse(env.fetchCalls[1].params.payload);
  assert.match(second.messages[0].content, /本文が .* 字です/);
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.GENERATED);
});

test('文字数違反が続けば生成失敗。本文は保存しない', () => {
  const { env, gas, sheet, COL, start } = setup();
  const short = validArticle({ intro_paragraphs: ['短い'] , section_1: { heading: 'a', paragraphs: ['b'] }, section_2: { heading: 'c', paragraphs: ['d'] }, section_3: { heading: 'e', paragraphs: ['f'] }, summary_paragraphs: ['g'] });
  env.fetchQueue.push(claudeResponse(short), claudeResponse(short));
  const r = gas.runGenerate_(sheet, 2, false, '', start);
  assert.equal(r.ok, false);
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.GENERATE_FAILED);
  assert.equal(cell(sheet, COL.FAILED_STAGE), gas.STAGE.GEN_VALIDATE);
  assert.match(cell(sheet, COL.ERROR), /本文が/);
  assert.equal(cell(sheet, COL.BODY), '');
});

const parseFailures = [
  ['max_tokens途中終了', () => claudeResponse('{"title":"途中', { stop_reason: 'max_tokens' }), /途中で終了/],
  ['refusal', () => claudeResponse('{}', { stop_reason: 'refusal', stop_details: { category: 'cyber' } }), /拒否.*cyber/],
  ['想定外のstop_reason', () => claudeResponse('{}', { stop_reason: 'pause_turn' }), /想定外の終了理由/],
  ['記事JSON不正', () => claudeResponse('これはJSONではない'), /JSONが不正/],
  ['API応答がJSONでない', () => fakeResponse(200, '<html>'), /JSONではありません/],
  ['本文なし', () => fakeResponse(200, { stop_reason: 'end_turn', content: [] }), /本文がありません/]
];
for (const [name, make, pattern] of parseFailures) {
  test('応答異常を検出して再試行しない: ' + name, () => {
    const { env, gas, sheet, COL, start } = setup();
    env.fetchQueue.push(make());
    const r = gas.runGenerate_(sheet, 2, false, '', start);
    assert.equal(r.ok, false);
    assert.equal(cell(sheet, COL.FAILED_STAGE), gas.STAGE.GEN_PARSE);
    assert.match(cell(sheet, COL.ERROR), pattern);
    assert.equal(cell(sheet, COL.BODY), '');
    assert.equal(env.fetchCalls.length, 1);
  });
}

test('APIエラー: 401は再試行せず、工程と内容を記録', () => {
  const { env, gas, sheet, COL, start } = setup();
  env.fetchQueue.push(fakeResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' }, request_id: 'req_1' }));
  const r = gas.runGenerate_(sheet, 2, false, '', start);
  assert.equal(r.ok, false);
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(cell(sheet, COL.FAILED_STAGE), gas.STAGE.GEN_API);
  assert.match(cell(sheet, COL.ERROR), /authentication_error.*req_1/);
});

test('APIエラー: 429/529/通信例外は再試行して成功できる', () => {
  const { env, gas, sheet, COL, start } = setup();
  env.fetchQueue.push(
    fakeResponse(429, { error: { type: 'rate_limit_error', message: 'x' } }, { 'retry-after': '1' }),
    () => { throw new Error('Address unavailable'); },
    claudeResponse(validArticle())
  );
  const r = gas.runGenerate_(sheet, 2, false, '', start);
  assert.equal(r.ok, true);
  assert.equal(env.fetchCalls.length, 3);
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.GENERATED);
});

test('APIエラー: 再試行上限で打ち切る', () => {
  const { env, gas, sheet, COL, start } = setup();
  const e = () => fakeResponse(529, { error: { type: 'overloaded_error', message: 'x' } });
  env.fetchQueue.push(e(), e(), e());
  const r = gas.runGenerate_(sheet, 2, false, '', start);
  assert.equal(r.ok, false);
  assert.equal(env.fetchCalls.length, 3);
  assert.match(cell(sheet, COL.ERROR), /overloaded_error/);
});

test('実行時間が足りなければAPIを呼ばない', () => {
  const { env, gas, sheet, COL } = setup();
  const r = gas.runGenerate_(sheet, 2, false, '', Date.now() - gas.LIMITS.EXECUTION_BUDGET_MS);
  assert.equal(r.ok, false);
  assert.equal(env.fetchCalls.length, 0);
  assert.match(cell(sheet, COL.ERROR), /実行時間/);
});

test('転載を検出した記事は保存しない', () => {
  const { env, gas, sheet, COL, start } = setup();
  const copied = 'サンプルにしか存在しない特徴的な言い回しを二十五字以上そのまま使った文。';
  const a = validArticle({ intro_paragraphs: [copied + 'あ'.repeat(300)] });
  env.fetchQueue.push(claudeResponse(a), claudeResponse(a));
  const r = gas.runGenerate_(sheet, 2, false, copied, start);
  assert.equal(r.ok, false);
  assert.match(cell(sheet, COL.ERROR), /文体サンプルと一致/);
  assert.equal(cell(sheet, COL.BODY), '');
});

test('A列が空なら生成しない', () => {
  const { env, gas, sheet, COL, start } = setup();
  sheet.write(2, COL.KEYWORD, '');
  assert.throws(() => gas.runGenerate_(sheet, 2, false, '', start), /キーワードが空/);
  assert.equal(env.fetchCalls.length, 0);
});

test('上書き防止: 生成済みの行は通常メニューでは生成しない', () => {
  const { env, gas, sheet, COL, start } = setupGenerated();
  const before = cell(sheet, COL.BODY);
  assert.throws(() => gas.runGenerate_(sheet, 2, false, '', start), /上書きしません/);
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(cell(sheet, COL.BODY), before);
});

test('上書き防止: ステータスが空でも本文があれば生成しない', () => {
  const { gas, sheet, COL, start } = setup();
  sheet.write(2, COL.BODY, '人が書いた本文');
  assert.throws(() => gas.runGenerate_(sheet, 2, false, '', start), /上書きしません/);
  assert.equal(cell(sheet, COL.BODY), '人が書いた本文');
});

test('再生成に失敗しても以前の記事と生成済みを保つ', () => {
  const { env, gas, sheet, COL, start } = setupGenerated();
  const before = cell(sheet, COL.BODY);
  env.fetchQueue.push(fakeResponse(400, { error: { type: 'invalid_request_error', message: 'bad' } }));
  const r = gas.runGenerate_(sheet, 2, true, '', start);
  assert.equal(r.ok, false);
  assert.equal(r.keptPrevious, true);
  assert.equal(cell(sheet, COL.BODY), before);
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.GENERATED);
  assert.equal(cell(sheet, COL.FAILED_STAGE), gas.STAGE.GEN_API);
});

test('投稿済み・投稿結果不明・投稿中の行は再生成不可', () => {
  for (const key of ['POSTED', 'POST_UNKNOWN', 'POSTING']) {
    const { env, gas, sheet, COL, start } = setupGenerated();
    sheet.write(2, COL.STATUS, gas.STATUS[key]);
    assert.throws(() => gas.runGenerate_(sheet, 2, true, '', start), /再生成できません/);
    assert.equal(env.fetchCalls.length, 0);
  }
});

test('投稿IDが残る行は、ステータスに関係なく再生成不可', () => {
  const { gas, sheet, COL, start } = setupGenerated();
  sheet.write(2, COL.WP_POST_ID, 12);
  assert.throws(() => gas.runGenerate_(sheet, 2, true, '', start), /再生成できません/);
});

test('二重実行: 生成中の行は拒否し、中断から時間が経っていれば再実行できる', () => {
  const { env, gas, sheet, COL, start } = setup();
  sheet.write(2, COL.STATUS, gas.STATUS.GENERATING);
  sheet.write(2, COL.UPDATED_AT, new Date());
  assert.throws(() => gas.runGenerate_(sheet, 2, false, '', start), /生成中です/);
  assert.equal(env.fetchCalls.length, 0);
  sheet.write(2, COL.UPDATED_AT, new Date(Date.now() - 8 * 60 * 1000));
  env.fetchQueue.push(claudeResponse(validArticle()));
  assert.equal(gas.runGenerate_(sheet, 2, false, '', start).ok, true);
});

// ---- 投稿工程 ----
test('既定では実送信しない: WP_SEND_ENABLED未設定は通信ゼロ・状態不変', () => {
  const { env, gas, sheet, COL } = setupGenerated(BASE_PROPS);
  const r = gas.runPost_(sheet, 2);
  assert.equal(r.kind, 'dry_run');
  assert.equal(r.preview.status, 'draft');
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.GENERATED);
  // 送信予定の4項目が実行ログに出る
  const log = env.logs.find((l) => l.includes('[送信テスト 2行目]'));
  assert.ok(log, 'ドライランのログがない');
  const payload = JSON.parse(log.slice(log.indexOf('{')));
  assert.deepEqual(Object.keys(payload), ['title', 'content', 'status', 'excerpt']);
  assert.equal(payload.status, 'draft');
  assert.equal(payload.title, cell(sheet, COL.TITLE).trim());
});

test('WP_SEND_ENABLED は厳密に true のときだけ有効', () => {
  for (const value of ['TRUE', '1', 'yes', 'false', '']) {
    const { env, gas, sheet } = setupGenerated({ ...WP_PROPS, WP_SEND_ENABLED: value });
    assert.equal(gas.runPost_(sheet, 2).kind, 'dry_run', value);
    assert.equal(env.fetchCalls.length, 0);
  }
});

test('投稿成功: 送信内容は4項目だけで draft、ID/URLを保存', () => {
  const { env, gas, sheet, COL } = setupGenerated();
  const body = cell(sheet, COL.BODY);
  env.fetchQueue.push(wpCreated());
  const r = gas.runPost_(sheet, 2);
  assert.equal(r.kind, 'created');
  const call = env.fetchCalls[0];
  assert.equal(call.url, 'https://example.com/wp-json/wp/v2/posts');
  assert.equal(call.params.method, 'post');
  assert.equal(call.params.followRedirects, false);
  const sent = JSON.parse(call.params.payload);
  assert.deepEqual(Object.keys(sent).sort(), ['content', 'excerpt', 'status', 'title']);
  assert.equal(sent.status, 'draft');
  assert.equal(sent.content, body);
  assert.equal(sent.excerpt, 'テスト記事の説明文です。');
  assert.equal(call.params.headers.Authorization, 'Basic ' + Buffer.from('editor:' + WP_PASS).toString('base64'));
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.POSTED);
  assert.equal(cell(sheet, COL.WP_POST_ID), 77);
  assert.equal(cell(sheet, COL.WP_URL), 'https://example.com/?p=77');
});

test('公開用のstatusを送る経路がコードにない', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'WordPress.gs'), 'utf8');
  assert.doesNotMatch(src, /['"](publish|future|private|pending)['"]/);
});

test('送信前に投稿中を確定する（通信中にシートが投稿中である）', () => {
  const { env, gas, sheet, COL } = setupGenerated();
  let statusDuringFetch;
  env.fetchQueue.push(() => { statusDuringFetch = cell(sheet, COL.STATUS); return wpCreated(); });
  gas.runPost_(sheet, 2);
  assert.equal(statusDuringFetch, gas.STATUS.POSTING);
});

const definiteFailures = [[400, 'rest_invalid'], [401, 'rest_not_logged_in'], [403, 'rest_cannot_create'], [404, 'rest_no_route'], [429, 'too_many']];
for (const [code, wpCode] of definiteFailures) {
  test(`投稿失敗 HTTP ${code}: 再投稿可能な投稿失敗になる`, () => {
    const { env, gas, sheet, COL } = setupGenerated();
    env.fetchQueue.push(fakeResponse(code, { code: wpCode, message: 'm' }));
    const r = gas.runPost_(sheet, 2);
    assert.equal(r.kind, 'failed');
    assert.equal(cell(sheet, COL.STATUS), gas.STATUS.POST_FAILED);
    assert.equal(cell(sheet, COL.FAILED_STAGE), gas.STAGE.POST_API);
    assert.match(cell(sheet, COL.ERROR), new RegExp(wpCode));
    env.fetchQueue.push(wpCreated());
    assert.equal(gas.runPost_(sheet, 2).kind, 'created');
  });
}

test('リダイレクトは投稿失敗（POSTが処理されていない）', () => {
  const { env, gas, sheet, COL } = setupGenerated();
  env.fetchQueue.push(fakeResponse(301, ''));
  assert.equal(gas.runPost_(sheet, 2).kind, 'failed');
  assert.match(cell(sheet, COL.ERROR), /WP_BASE_URL/);
});

const unknownCases = [
  ['通信例外', () => () => { throw new Error('Timeout'); }],
  ['HTTP 500', () => fakeResponse(500, '')],
  ['HTTP 502', () => fakeResponse(502, '')],
  ['HTTP 504', () => fakeResponse(504, '')],
  ['HTTP 408', () => fakeResponse(408, '')],
  ['201でJSON不正', () => fakeResponse(201, '<html>')],
  ['200でIDなし', () => fakeResponse(200, { status: 'draft' })]
];
for (const [name, make] of unknownCases) {
  test('結果不明は自動再投稿しない: ' + name, () => {
    const { env, gas, sheet, COL } = setupGenerated();
    env.fetchQueue.push(make());
    const r = gas.runPost_(sheet, 2);
    assert.equal(r.kind, 'unknown');
    assert.equal(cell(sheet, COL.STATUS), gas.STATUS.POST_UNKNOWN);
    assert.equal(env.fetchCalls.length, 1);
    assert.throws(() => gas.runPost_(sheet, 2), /投稿結果が不明/);
    assert.equal(env.fetchCalls.length, 1, '再度実行しても送信しない');
  });
}

test('draft以外で作成されたら結果不明にしてIDを残す', () => {
  const { env, gas, sheet, COL } = setupGenerated();
  env.fetchQueue.push(wpCreated({ status: 'publish' }));
  const r = gas.runPost_(sheet, 2);
  assert.equal(r.kind, 'unknown');
  assert.equal(cell(sheet, COL.WP_POST_ID), 77);
  assert.match(cell(sheet, COL.ERROR), /publish/);
});

test('投稿中のまま中断した行: 直後は拒否、時間経過後は結果不明になり送信しない', () => {
  const { env, gas, sheet, COL } = setupGenerated();
  sheet.write(2, COL.STATUS, gas.STATUS.POSTING);
  sheet.write(2, COL.UPDATED_AT, new Date());
  assert.throws(() => gas.runPost_(sheet, 2), /投稿処理中/);
  sheet.write(2, COL.UPDATED_AT, new Date(Date.now() - 8 * 60 * 1000));
  const r = gas.runPost_(sheet, 2);
  assert.equal(r.kind, 'unknown');
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.POST_UNKNOWN);
  assert.equal(env.fetchCalls.length, 0);
});

test('二重投稿防止: 投稿済み・投稿IDあり・未生成の行は送信しない', () => {
  const a = setupGenerated();
  a.sheet.write(2, a.COL.STATUS, a.gas.STATUS.POSTED);
  assert.throws(() => a.gas.runPost_(a.sheet, 2), /投稿できません/);
  const b = setupGenerated();
  b.sheet.write(2, b.COL.WP_POST_ID, 5);
  assert.throws(() => b.gas.runPost_(b.sheet, 2), /投稿しません/);
  const c = setup(WP_PROPS);
  assert.throws(() => c.gas.runPost_(c.sheet, 2), /投稿できません/);
  assert.equal(a.env.fetchCalls.length + b.env.fetchCalls.length + c.env.fetchCalls.length, 0);
});

test('人の編集で条件を外れた本文は送信前に止める', () => {
  const { env, gas, sheet, COL } = setupGenerated();
  sheet.write(2, COL.BODY, '<p>短い</p>');
  assert.throws(() => gas.runPost_(sheet, 2), /本文が/);
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.GENERATED);
});

test('WP設定不足・httpのURLは状態を変えず止める', () => {
  const a = setupGenerated({ ...BASE_PROPS, WP_SEND_ENABLED: 'true' });
  assert.throws(() => a.gas.runPost_(a.sheet, 2), /未設定/);
  assert.equal(cell(a.sheet, a.COL.STATUS), a.gas.STATUS.GENERATED);
  const b = setupGenerated({ ...WP_PROPS, WP_BASE_URL: 'http://example.com' });
  assert.throws(() => b.gas.runPost_(b.sheet, 2), /https/);
  const c = setupGenerated({ ...WP_PROPS, WP_BASE_URL: 'https://user:pass@example.com' });
  assert.throws(() => c.gas.runPost_(c.sheet, 2), /https/);
  assert.equal(a.env.fetchCalls.length + b.env.fetchCalls.length + c.env.fetchCalls.length, 0);
});

// ---- 結果不明の確定 ----
function setupUnknown() {
  const ctx = setupGenerated();
  ctx.sheet.write(2, ctx.COL.STATUS, ctx.gas.STATUS.POST_UNKNOWN);
  return ctx;
}

test('結果不明の確定: IDを検証して投稿済みにする', () => {
  const { env, gas, sheet, COL } = setupUnknown();
  env.fetchQueue.push(fakeResponse(200, { id: 88, status: 'draft', link: 'https://example.com/?p=88', title: { raw: 'T' } }));
  const r = gas.resolveUnknownAsPosted_(sheet, 2, ' 88 ');
  assert.equal(r.id, 88);
  assert.match(env.fetchCalls[0].url, /\/posts\/88\?context=edit$/);
  assert.equal(env.fetchCalls[0].params.method, 'get');
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.POSTED);
  assert.equal(cell(sheet, COL.WP_POST_ID), 88);
});

test('結果不明の確定: 不正なIDと存在しないIDは拒否', () => {
  const { env, gas, sheet, COL } = setupUnknown();
  assert.throws(() => gas.resolveUnknownAsPosted_(sheet, 2, 'abc'), /正の整数/);
  assert.throws(() => gas.resolveUnknownAsPosted_(sheet, 2, '../users'), /正の整数/);
  env.fetchQueue.push(fakeResponse(404, { code: 'rest_post_invalid_id', message: 'x' }));
  assert.throws(() => gas.resolveUnknownAsPosted_(sheet, 2, '99'), /rest_post_invalid_id/);
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.POST_UNKNOWN);
});

test('結果不明の確定: 未投稿と確認すれば再投稿でき、IDがあれば戻せない', () => {
  const { env, gas, sheet, COL } = setupUnknown();
  gas.resolveUnknownAsNotPosted_(sheet, 2);
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.POST_FAILED);
  env.fetchQueue.push(wpCreated());
  assert.equal(gas.runPost_(sheet, 2).kind, 'created');

  const b = setupUnknown();
  b.sheet.write(2, b.COL.WP_POST_ID, 5);
  assert.throws(() => b.gas.resolveUnknownAsNotPosted_(b.sheet, 2), /未投稿にはできません/);
});

test('結果不明以外の行は確定操作できない', () => {
  const { gas, sheet } = setupGenerated();
  assert.throws(() => gas.resolveUnknownAsPosted_(sheet, 2, '1'), /だけ確定できます/);
  assert.throws(() => gas.resolveUnknownAsNotPosted_(sheet, 2), /だけ処理できます/);
});

// ---- 選択・ロック・メニュー ----
test('選択: 複数行・見出し行・別シートは拒否', () => {
  const { env, gas, sheet } = setup();
  sheet.select(2, 2);
  assert.throws(() => gas.getSelectedRow_(), /1行だけ/);
  sheet.select(1);
  assert.throws(() => gas.getSelectedRow_(), /見出し行/);
  sheet.selection = [[2, 1], [4, 1]];
  assert.throws(() => gas.getSelectedRow_(), /1行だけ/);
  env.book.active = env.sheets.get(gas.SAMPLE_SHEET_NAME);
  assert.throws(() => gas.getSelectedRow_(), /シート/);
});

test('メニュー: 複数行選択なら通信せず案内のみ', () => {
  const { env, gas, sheet } = setup();
  sheet.select(2, 3);
  gas.menuGenerate();
  assert.equal(env.fetchCalls.length, 0);
  assert.match(env.alerts.join(), /1行だけ/);
});

test('メニュー: ロックを取れなければ何もしない', () => {
  const { env, gas } = setup();
  env.setLockAvailable(false);
  gas.menuGenerate();
  gas.menuPost();
  assert.equal(env.fetchCalls.length, 0);
  assert.match(env.alerts.join(), /別の処理が実行中/);
});

test('メニュー: サンプルが空の確認でNOなら生成しない', () => {
  const { env, gas } = setup();
  env.ui.answers = ['NO'];
  gas.menuGenerate();
  assert.equal(env.fetchCalls.length, 0);
});

test('メニュー: 生成〜投稿の通しで、サンプルがプロンプトに入る', () => {
  const { env, gas, sheet, COL } = setup(WP_PROPS);
  env.sheets.get(gas.SAMPLE_SHEET_NAME).write(2, 1, '文体サンプルの本文');
  env.fetchQueue.push(claudeResponse(validArticle()));
  gas.menuGenerate();
  assert.match(JSON.parse(env.fetchCalls[0].params.payload).messages[0].content, /<style_sample>\n文体サンプルの本文/);
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.GENERATED);
  env.ui.answers = ['OK'];
  env.fetchQueue.push(wpCreated());
  gas.menuPost();
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.POSTED);
  assert.match(env.alerts.join(), /事実確認は「確認済み」になっていません/);
});

test('メニュー: 投稿確認でキャンセルすれば送信しない', () => {
  const { env, gas, sheet, COL } = setupGenerated();
  env.ui.answers = ['CANCEL'];
  gas.menuPost();
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.GENERATED);
});

test('メニュー: 再生成の確認でNOなら通信しない', () => {
  const { env, gas } = setupGenerated();
  env.ui.answers = ['NO'];
  gas.menuRegenerate();
  assert.equal(env.fetchCalls.length, 0);
});

test('onOpenでメニューを登録する', () => {
  const { env, gas } = setup();
  gas.onOpen();
  assert.equal(env.menuAdded, true);
});

// ---- 秘密情報 ----
test('秘密情報: APIキーとパスワードをシート・ログ・ダイアログに出さない', () => {
  const { env, gas, sheet, COL } = setupGenerated();
  const b64 = Buffer.from('editor:' + WP_PASS).toString('base64');
  env.fetchQueue.push(fakeResponse(403, { code: 'x', message: `leak ${SECRET_KEY} ${WP_PASS} ${b64}` }));
  gas.runPost_(sheet, 2);
  const err = cell(sheet, COL.ERROR);
  assert.ok(!err.includes(SECRET_KEY) && !err.includes(WP_PASS) && !err.includes(b64), err);

  const other = setup();
  other.env.fetchQueue.push(() => { throw new Error('boom ' + SECRET_KEY); }, () => { throw new Error('boom ' + SECRET_KEY); }, () => { throw new Error('boom ' + SECRET_KEY); });
  other.gas.runGenerate_(other.sheet, 2, false, '', other.start);
  assert.ok(!cell(other.sheet, other.COL.ERROR).includes(SECRET_KEY));

  const third = setupGenerated();
  third.gas.describeConfigStatus_();
  const status = third.gas.describeConfigStatus_();
  assert.ok(!status.includes(SECRET_KEY) && !status.includes(WP_PASS));
  assert.match(status, /ANTHROPIC_API_KEY: 設定済み/);

  for (const e of [env, other.env, third.env]) {
    const all = e.logs.concat(e.alerts).join('\n');
    assert.ok(!all.includes(SECRET_KEY) && !all.includes(WP_PASS));
  }
});

test('秘密情報: 未知の形式のキーも sk-ant- で始まれば伏せる', () => {
  const { gas } = setup();
  assert.equal(gas.sanitizeMessage_('x sk-ant-other-KEY_1 y'), 'x [秘匿] y');
});

test('ソースに秘密情報らしき値を含まない', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src');
  for (const f of fs.readdirSync(dir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /sk-ant-[A-Za-z0-9]/, f);
  }
});

// ---- シート保護 ----
test('数式インジェクション: 先頭が = の文字列は文字列として書く', () => {
  const { gas } = setup();
  assert.equal(gas.sheetSafe_('=IMPORTXML("x")'), "'=IMPORTXML(\"x\")");
  assert.equal(gas.sheetSafe_('通常'), '通常');
  assert.equal(gas.sheetSafe_(5), 5);
});

test('シート準備: 別の見出しがあれば上書きしない', () => {
  const env = createEnv(BASE_PROPS);
  const sheet = env.book.insertSheet(env.gas.SHEET_NAME);
  sheet.write(1, 1, '別の列');
  assert.throws(() => env.gas.prepareSheets_(), /別の見出し/);
  assert.equal(sheet.read(1, 1), '別の列');
});

test('シート準備: A〜G列が既にあれば管理列を追加し、列数不足も補う', () => {
  const env = createEnv(BASE_PROPS);
  const { gas } = env;
  const sheet = env.book.insertSheet(gas.SHEET_NAME);
  sheet.maxCols = 7;
  gas.HEADERS.slice(0, 7).forEach((h, i) => sheet.write(1, i + 1, h));
  gas.prepareSheets_();
  assert.equal(sheet.read(1, gas.COL.UPDATED_AT), '更新日時');
  assert.equal(sheet.getMaxColumns(), gas.HEADERS.length);
});

test('列の順番が変わっていれば処理しない', () => {
  const { gas, sheet, COL } = setup();
  sheet.write(1, COL.TITLE, '題名');
  assert.throws(() => gas.getManagedSheet_(), /見出しが/);
});

test('サンプルの上限超過は黙って切り詰めず止める', () => {
  const { env, gas } = setup();
  env.sheets.get(gas.SAMPLE_SHEET_NAME).write(2, 1, 'あ'.repeat(gas.LIMITS.SAMPLE_MAX_CHARS + 1));
  assert.throws(() => gas.readStyleSample_(), /超えています/);
});

// ---- 設定値 ----
test('設定: APIキー未設定・不正な値は生成前に止める', () => {
  const a = setup({});
  assert.throws(() => a.gas.runGenerate_(a.sheet, 2, false, '', a.start), /ANTHROPIC_API_KEY/);
  assert.equal(cell(a.sheet, a.COL.STATUS), '');
  const b = setup({ ...BASE_PROPS, CLAUDE_EFFORT: 'ultra' });
  assert.throws(() => b.gas.getClaudeConfig_(), /CLAUDE_EFFORT/);
  const c = setup({ ...BASE_PROPS, CLAUDE_MAX_TOKENS: '-1' });
  assert.throws(() => c.gas.getClaudeConfig_(), /CLAUDE_MAX_TOKENS/);
});

test('接続テスト: モデル取得APIとusers/meはGETのみで書き込まない', () => {
  const { env, gas } = setup(WP_PROPS);
  env.fetchQueue.push(fakeResponse(200, { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }));
  assert.equal(gas.testClaudeConnection_().id, 'claude-opus-5-5');
  env.fetchQueue.push(fakeResponse(200, { name: '編集者', capabilities: { edit_posts: true } }));
  assert.equal(gas.testWordPressConnection_().canEditPosts, true);
  for (const call of env.fetchCalls) assert.equal(call.params.method, 'get');
});

test('ワークスペースID: 未設定ならヘッダーを送らない', () => {
  const { env, gas } = setup();
  assert.ok(!('anthropic-workspace-id' in gas.buildClaudeRequest_(gas.getClaudeConfig_(), { keyword: 'k', subKeyword: '' }, '', '').headers));
  env.fetchQueue.push(fakeResponse(200, { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }));
  gas.testClaudeConnection_();
  assert.ok(!('anthropic-workspace-id' in env.fetchCalls[0].params.headers));
});

test('ワークスペースID: 設定時は生成と接続テストの両方で送る', () => {
  const { env, gas } = setup({ ...BASE_PROPS, ANTHROPIC_WORKSPACE_ID: ' wrkspc_01ABCdef ' });
  const req = gas.buildClaudeRequest_(gas.getClaudeConfig_(), { keyword: 'k', subKeyword: '' }, '', '');
  assert.equal(req.headers['anthropic-workspace-id'], 'wrkspc_01ABCdef');
  env.fetchQueue.push(fakeResponse(200, { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }));
  gas.testClaudeConnection_();
  assert.equal(env.fetchCalls[0].params.headers['anthropic-workspace-id'], 'wrkspc_01ABCdef');
});

test('ワークスペースID: 形式が違えば通信前に止める', () => {
  const { env, gas } = setup({ ...BASE_PROPS, ANTHROPIC_WORKSPACE_ID: 'Default Workspace' });
  assert.throws(() => gas.testClaudeConnection_(), /wrkspc_/);
  assert.equal(env.fetchCalls.length, 0);
});

// ---- レビューで追加 ----
test('読み込み順に依存しない（GASのファイル順が変わっても動く）', () => {
  const env = createEnv(BASE_PROPS, { reverseLoad: true });
  const sheet = env.newSheet();
  sheet.write(2, env.gas.COL.KEYWORD, 'k');
  sheet.select(2);
  env.fetchQueue.push(claudeResponse(validArticle()));
  assert.equal(env.gas.runGenerate_(sheet, 2, false, '', Date.now()).ok, true);
});

test('メニュー項目はすべて実在する公開関数を指す', () => {
  const { env, gas } = setup();
  gas.onOpen();
  assert.ok(env.menuFunctions.length >= 10);
  for (const name of env.menuFunctions) {
    assert.equal(typeof gas[name], 'function', name);
    assert.ok(!name.endsWith('_'), name + ' は末尾_だとメニューから実行できない');
  }
});

test('日本語を含むユーザー名をUTF-8で認証ヘッダーにする', () => {
  const { env, gas, sheet } = setupGenerated({ ...WP_PROPS, WP_USERNAME: '編集者' });
  env.fetchQueue.push(wpCreated());
  gas.runPost_(sheet, 2);
  const expected = 'Basic ' + Buffer.from('編集者:' + WP_PASS, 'utf8').toString('base64');
  assert.equal(env.fetchCalls[0].params.headers.Authorization, expected);
});

test('日本語本文を送るPOSTは文字コードを明示する', () => {
  const a = setup();
  a.env.fetchQueue.push(claudeResponse(validArticle()));
  a.gas.runGenerate_(a.sheet, 2, false, '', a.start);
  assert.match(a.env.fetchCalls[0].params.contentType, /charset=utf-8/);
  const b = setupGenerated();
  b.env.fetchQueue.push(wpCreated());
  b.gas.runPost_(b.sheet, 2);
  assert.match(b.env.fetchCalls[0].params.contentType, /charset=utf-8/);
});

test('E列にURLだけ残る行も二重投稿しない', () => {
  const { env, gas, sheet, COL } = setupGenerated();
  sheet.write(2, COL.WP_URL, 'https://example.com/?p=1');
  assert.throws(() => gas.runPost_(sheet, 2), /記録済み/);
  assert.equal(env.fetchCalls.length, 0);
});

test('フォールバック応答: 本文を読み取り、実際に応答したモデルをM列に残す', () => {
  const { env, gas, sheet, COL, start } = setup();
  env.fetchQueue.push(fakeResponse(200, {
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    content: [
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'text', text: JSON.stringify(validArticle()) }
    ]
  }));
  assert.equal(gas.runGenerate_(sheet, 2, false, '', start).ok, true);
  assert.equal(cell(sheet, COL.MODEL), 'claude-opus-4-8');
});

test('fact_check_items の不正な要素は例外にせず検証違反にする', () => {
  const { gas } = setup();
  assert.match(gas.validateArticleShape_(validArticle({ fact_check_items: [null] })).join(), /形式が不正/);
  assert.match(gas.validateArticleShape_(validArticle({ fact_check_items: 'x' })).join(), /配列ではありません/);
});

test('空タイトルでは下書きを検索しない（全件取得を防ぐ）', () => {
  const { env, gas } = setup(WP_PROPS);
  assert.throws(() => gas.searchDraftCandidates_(''), /タイトルが空/);
  assert.equal(env.fetchCalls.length, 0);
});

test('メニュー: 下書き検索・投稿確定・未投稿確定を通しで実行できる', () => {
  const { env, gas, sheet, COL } = setupUnknown();
  env.fetchQueue.push(fakeResponse(200, [{ id: 5, title: { raw: 'T' }, date: '2026-11-01' }]));
  gas.menuSearchDraft();
  assert.match(env.alerts.join(), /ID 5/);
  env.ui.promptAnswers = [{ button: 'OK', text: '5' }];
  env.fetchQueue.push(fakeResponse(200, { id: 5, status: 'draft', link: 'https://example.com/?p=5', title: { raw: 'T' } }));
  gas.menuResolvePosted();
  assert.equal(cell(sheet, COL.STATUS), gas.STATUS.POSTED);

  const b = setupUnknown();
  b.env.ui.answers = ['YES'];
  b.gas.menuResolveNotPosted();
  assert.equal(cell(b.sheet, b.COL.STATUS), b.gas.STATUS.POST_FAILED);
  const c = setupUnknown();
  c.env.ui.promptAnswers = [{ button: 'CANCEL', text: '' }];
  c.gas.menuResolvePosted();
  assert.equal(c.env.fetchCalls.length, 0);
  assert.equal(cell(c.sheet, c.COL.STATUS), c.gas.STATUS.POST_UNKNOWN);
});

test('メニュー: 設定確認と準備は通信しない。接続テストの失敗はダイアログで伝える', () => {
  const { env, gas } = setup();
  gas.menuCheckConfig();
  gas.menuPrepare();
  assert.equal(env.fetchCalls.length, 0);
  env.fetchQueue.push(fakeResponse(401, { error: { type: 'authentication_error', message: 'x' } }));
  gas.menuTestClaude();
  assert.match(env.alerts.join(), /authentication_error/);
  assert.ok(!env.alerts.join().includes(SECRET_KEY));
});

test('複数行のサンプルは連結され、区切りタグの中に入る', () => {
  const { env, gas } = setup();
  const s = env.sheets.get(gas.SAMPLE_SHEET_NAME);
  for (let i = 0; i < 5; i++) s.write(2 + i, 1, 'ダミーサンプル' + i);
  const text = gas.readStyleSample_();
  for (let i = 0; i < 5; i++) assert.ok(text.includes('ダミーサンプル' + i));
});

test('複数行あっても処理するのは選択した1行だけ（ダミーの5行で確認）', () => {
  const { env, gas, sheet, COL } = setup();
  for (let r = 2; r <= 6; r++) sheet.write(r, COL.KEYWORD, 'ダミー' + r);
  sheet.select(4);
  env.fetchQueue.push(claudeResponse(validArticle()));
  gas.menuGenerate();
  assert.equal(env.fetchCalls.length, 1);
  assert.match(JSON.parse(env.fetchCalls[0].params.payload).messages[0].content, /ダミー4/);
  for (let r = 2; r <= 6; r++) {
    assert.equal(sheet.read(r, COL.STATUS), r === 4 ? gas.STATUS.GENERATED : '', 'row ' + r);
  }
});

// ---- ダミー素材での確認（外部通信なし） ----
// キーワードと文体サンプルは、テスト用に自作したもの。講座の支給素材は使わない。
// 形式は手元の素材と同じ（キーワードは見出し行つきのTSV、サンプルは空行で区切った段落）。
const DUMMY_KEYWORDS_TSV = [
  'メインキーワード\tサブキーワード',
  '会議 準備 効率化\t議題, 資料',
  '社内マニュアル 作り方\t手順書, 更新',
  'タスク管理 チーム 共有\t期限, 優先度',
  'メール 返信 時短\tテンプレート, 署名',
  '在庫管理 小規模 方法\t棚卸し, 発注点'
].join('\n') + '\n';

const DUMMY_STYLE_SAMPLE = [
  '「会議の準備をスムーズにする3つの工夫」',
  '「資料が前日の夜まで決まらない」「当日になって議題が増える」。そんな状況が続くと、参加者の時間も集中力も少しずつ削られていきます。この記事では、会議の準備を軽くするための工夫を、明日から試せる順番で紹介します。',
  '工夫1：議題は前日の昼までに共有する',
  '議題が直前まで決まらないと、参加者は何を考えてくればよいのか分かりません。前日の昼までに議題を共有するだけで、当日の話し合いはぐっと進めやすくなります。決めきれない議題は「相談したいこと」として書き添えておけば十分です。',
  '工夫2：資料は結論から書く',
  '説明の順番どおりに資料を作ると、言いたいことが最後のページまで出てきません。最初の1枚に結論と決めてほしいことを書いておけば、読む側は迷わずに済みます。細かいデータは後ろにまとめて置きましょう。',
  '工夫3：終わったらすぐに決定事項を残す',
  '会議の内容は、時間がたつほど人によって覚え方がずれていきます。終わった直後に、決まったことと担当者と期限の3点だけを共有しておくと、次の会議の準備もそのまま始められます。',
  'ここまで3つの工夫を紹介しましたが、全部を一度に始める必要はありません。次の会議で一つだけ試してみるのが、ちょうどよい始め方です。'
].join('\n\n') + '\n';

function loadMaterials() {
  const keywords = DUMMY_KEYWORDS_TSV
    .trim().split('\n').slice(1).map((l) => l.split('\t'));
  const sample = DUMMY_STYLE_SAMPLE;
  return { keywords, sample };
}

function putMaterials(env, sheet, keywords, sample) {
  const { gas } = env;
  keywords.forEach(([k, s], i) => {
    sheet.write(2 + i, gas.COL.KEYWORD, k);
    sheet.write(2 + i, gas.COL.SUB_KEYWORD, s);
  });
  const sampleSheet = env.sheets.get(gas.SAMPLE_SHEET_NAME);
  sample.split(/\n+/).filter(Boolean).forEach((line, i) => sampleSheet.write(2 + i, 1, line));
}

test('ダミー素材: キーワード5本が欠けず、サンプルは上限内で注記を含まない', () => {
  const { keywords, sample } = loadMaterials();
  assert.equal(keywords.length, 5);
  assert.ok(keywords.every((c) => c.length === 2 && c[0] && c[1]));
  assert.ok(sample.includes('会議の準備をスムーズにする3つの工夫'));
  assert.ok(sample.includes('ちょうどよい始め方です。'));
  assert.ok(!sample.includes('支給サンプル'));
  const { gas } = setup();
  assert.ok(gas.countChars_(sample) <= gas.LIMITS.SAMPLE_MAX_CHARS);
});

test('ダミー素材: 5行それぞれのリクエストにキーワードとサンプルが正しく入る', () => {
  const { keywords, sample } = loadMaterials();
  const { env, gas, sheet } = setup();
  putMaterials(env, sheet, keywords, sample);
  const styled = gas.readStyleSample_();
  assert.ok(styled.includes('明日から試せる順番で紹介します。'));
  keywords.forEach(([k, s], i) => {
    const row = gas.readRow_(sheet, 2 + i);
    const req = gas.buildClaudeRequest_(gas.getClaudeConfig_(), row, styled, '');
    const prompt = req.payload.messages[0].content;
    assert.ok(prompt.includes(`<keyword>${k}</keyword>`));
    assert.ok(prompt.includes(`<sub_keywords>${s}</sub_keywords>`));
    assert.ok(prompt.includes('<style_sample>'));
    assert.ok(!prompt.includes('＜'), 'サンプルの本文が変形していない');
  });
});

test('ダミー素材: サンプルの文をそのまま使った記事は保存しない', () => {
  const { keywords, sample } = loadMaterials();
  const { env, gas, sheet, COL, start } = setup();
  putMaterials(env, sheet, keywords, sample);
  const styled = gas.readStyleSample_();
  const copied = '前日の昼までに議題を共有するだけで、当日の話し合いはぐっと進めやすくなります。';
  assert.ok(sample.includes(copied), '転載とみなす文はサンプルの中にある');
  const a = validArticle({ intro_paragraphs: [copied + 'あ'.repeat(300)] });
  env.fetchQueue.push(claudeResponse(a), claudeResponse(a));
  const r = gas.runGenerate_(sheet, 2, false, styled, start);
  assert.equal(r.ok, false);
  assert.match(cell(sheet, COL.ERROR), /文体サンプルと一致/);
  assert.equal(cell(sheet, COL.BODY), '');
});

test('ダミー素材: 送信ペイロードの確認は通信せず、下書き4項目だけを示す', () => {
  const { keywords, sample } = loadMaterials();
  const { env, gas, sheet, COL, start } = setup();
  putMaterials(env, sheet, keywords, sample);
  env.fetchQueue.push(claudeResponse(validArticle()));
  gas.runGenerate_(sheet, 2, false, gas.readStyleSample_(), start);
  const calls = env.fetchCalls.length;
  const before = cell(sheet, COL.STATUS);
  const r = gas.runPost_(sheet, 2);
  assert.equal(r.kind, 'dry_run');
  assert.equal(env.fetchCalls.length, calls);
  assert.equal(cell(sheet, COL.STATUS), before);
  const payload = gas.buildWordPressPayload_(gas.readRow_(sheet, 2));
  assert.deepEqual(Object.keys(payload).sort(), ['content', 'excerpt', 'status', 'title']);
  assert.equal(payload.status, 'draft');
});

test('要確認事項: 今回の題材の労務語句を機械検出する', () => {
  const { gas } = setup();
  const sentences = [
    '有給休暇は年に5日の取得が義務です。',
    '残業時間には36協定による上限規制があります。',
    '特別条項を結ぶ必要があります。',
    '違反すると罰則の対象になります。',
    '割増賃金率が引き上げられました。',
    '法改正が続いています。',
    '時間外労働は月45時間までです。'
  ];
  for (const s of sentences) {
    const items = Array.from(gas.scanFactCandidates_(`<p>${s}</p>`));
    assert.ok(items.some((i) => i.claim === s), s);
  }
  assert.equal(gas.scanFactCandidates_('<p>まずは現状を整理しましょう。</p>').length, 0);
});
