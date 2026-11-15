/**
 * @OnlyCurrentDoc
 * 定数と設定の読み込み。APIキー等の秘密情報はスクリプトプロパティだけに置く。
 */

var SHEET_NAME = '記事管理';
var SAMPLE_SHEET_NAME = '文体サンプル';
var HEADER_ROW = 1;

// 1始まりの列番号。A〜Gは仕様で固定、H以降は管理列。
var COL = {
  KEYWORD: 1,
  SUB_KEYWORD: 2,
  STATUS: 3,
  TITLE: 4,
  WP_URL: 5,
  BODY: 6,
  META: 7,
  FACT_STATUS: 8,
  FACT_ITEMS: 9,
  WP_POST_ID: 10,
  FAILED_STAGE: 11,
  ERROR: 12,
  MODEL: 13,
  UPDATED_AT: 14
};

var HEADERS = [
  'キーワード', 'サブキーワード', 'ステータス', 'タイトル', 'WordPress URL',
  '記事本文', 'メタディスクリプション', '事実確認（人が記入）', '要確認事項',
  'WordPress投稿ID', '失敗工程', 'エラー内容', '生成モデル', '更新日時'
];

var STATUS = {
  EMPTY: '',
  GENERATING: '生成中',
  GENERATED: '生成済み',
  GENERATE_FAILED: '生成失敗',
  POSTING: '投稿中',
  POSTED: '投稿済み（下書き）',
  POST_FAILED: '投稿失敗',
  POST_UNKNOWN: '投稿結果不明'
};

var STAGE = {
  GEN_INPUT: '生成: 入力確認',
  GEN_API: '生成: Claude API',
  GEN_PARSE: '生成: 応答解析',
  GEN_VALIDATE: '生成: 内容検証',
  POST_INPUT: '投稿: 送信前検証',
  POST_API: '投稿: WordPress API',
  POST_RECOVERY: '投稿: 中断からの復旧'
};

var FACT_STATUS = { UNCHECKED: '未確認', CHECKED: '確認済み', NEEDS_FIX: '要修正' };

var LIMITS = {
  BODY_MIN_CHARS: 2000,
  BODY_MAX_CHARS: 3000,
  META_MAX_CHARS: 120,
  BODY_H2_COUNT: 3,
  COPY_RUN_CHARS: 25,          // サンプルとこの文字数以上一致したら転載とみなす
  SAMPLE_MAX_CHARS: 20000,
  ERROR_MAX_CHARS: 500,
  EXECUTION_BUDGET_MS: 330000, // GASの6分制限より手前で打ち切る
  MIN_REMAINING_MS: 90000,     // これ未満しか残らなければ再試行しない
  STALE_MINUTES: 7             // GASの最大実行時間より長く動いている行は中断扱い
};

var SUMMARY_HEADING = 'まとめ';

var ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models/';
var ANTHROPIC_VERSION = '2026-10-21';
var ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

var DEFAULTS = {
  CLAUDE_MODEL: 'claude-opus-5-5',
  CLAUDE_EFFORT: 'medium',
  CLAUDE_MAX_TOKENS: 16000,
  CLAUDE_FALLBACKS: 'default',
  GEN_MAX_ATTEMPTS: 2
};

var EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'];
var SECRET_PROPERTY_NAMES = ['ANTHROPIC_API_KEY', 'WP_APP_PASSWORD'];

function getProp_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  return value === null ? '' : String(value).trim();
}

function getClaudeConfig_() {
  var apiKey = getProp_('ANTHROPIC_API_KEY');
  if (!apiKey) throw new ConfigError_('スクリプトプロパティ ANTHROPIC_API_KEY が未設定です。');

  var effort = getProp_('CLAUDE_EFFORT') || DEFAULTS.CLAUDE_EFFORT;
  if (EFFORT_VALUES.indexOf(effort) === -1) {
    throw new ConfigError_('CLAUDE_EFFORT の値が不正です（' + EFFORT_VALUES.join(' / ') + '）。');
  }
  // ワークスペースに紐づかないキーでは、リクエストごとにワークスペースIDの指定が必要。
  var workspaceId = getProp_('ANTHROPIC_WORKSPACE_ID');
  if (workspaceId && !/^wrkspc_[A-Za-z0-9]+$/.test(workspaceId)) {
    throw new ConfigError_('ANTHROPIC_WORKSPACE_ID は wrkspc_ で始まるワークスペースIDにしてください。');
  }
  var maxTokens = parsePositiveInt_(getProp_('CLAUDE_MAX_TOKENS'), DEFAULTS.CLAUDE_MAX_TOKENS, 'CLAUDE_MAX_TOKENS');
  var maxAttempts = parsePositiveInt_(getProp_('GEN_MAX_ATTEMPTS'), DEFAULTS.GEN_MAX_ATTEMPTS, 'GEN_MAX_ATTEMPTS');

  return {
    apiKey: apiKey,
    workspaceId: workspaceId,
    model: getProp_('CLAUDE_MODEL') || DEFAULTS.CLAUDE_MODEL,
    effort: effort,
    maxTokens: maxTokens,
    maxAttempts: Math.min(maxAttempts, 3),
    fallbacks: (getProp_('CLAUDE_FALLBACKS') || DEFAULTS.CLAUDE_FALLBACKS) !== 'off'
  };
}

function isWpSendEnabled_() {
  return getProp_('WP_SEND_ENABLED') === 'true';
}

function getWordPressConfig_() {
  var baseUrl = getProp_('WP_BASE_URL').replace(/\/+$/, '');
  var username = getProp_('WP_USERNAME');
  var appPassword = getProp_('WP_APP_PASSWORD');
  var missing = [];
  if (!baseUrl) missing.push('WP_BASE_URL');
  if (!username) missing.push('WP_USERNAME');
  if (!appPassword) missing.push('WP_APP_PASSWORD');
  if (missing.length) throw new ConfigError_('スクリプトプロパティが未設定です: ' + missing.join(', '));
  if (!/^https:\/\/[^\s\/@]+(\/[^\s]*)?$/.test(baseUrl)) {
    throw new ConfigError_('WP_BASE_URL は https:// で始まるURLにしてください（認証情報を含めないこと）。');
  }
  return { baseUrl: baseUrl, username: username, appPassword: appPassword };
}

function parsePositiveInt_(raw, fallback, name) {
  if (!raw) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new ConfigError_(name + ' は正の整数で指定してください。');
  return parseInt(raw, 10);
}

/** 日本語のユーザー名でも認証できるよう、文字コードを明示する。 */
function base64Utf8_(text) {
  return Utilities.base64Encode(text, Utilities.Charset.UTF_8);
}

/** 設定不備。再実行しても直らないので利用者に設定を直してもらう。 */
function ConfigError_(message) {
  this.name = 'ConfigError';
  this.message = message;
  this.stack = new Error(message).stack;
}
ConfigError_.prototype = Object.create(Error.prototype);
ConfigError_.prototype.constructor = ConfigError_;

/** 工程付きの失敗。stage をシートの「失敗工程」へ記録する。 */
function StageError_(stage, message) {
  this.name = 'StageError';
  this.stage = stage;
  this.message = message;
  this.stack = new Error(message).stack;
}
StageError_.prototype = Object.create(Error.prototype);
StageError_.prototype.constructor = StageError_;

/** シート・ログに出す文字列から秘密情報を除去し、長さを制限する。 */
function sanitizeMessage_(message) {
  var text = String(message === undefined || message === null ? '' : message);
  SECRET_PROPERTY_NAMES.forEach(function (name) {
    var secret = getProp_(name);
    if (secret) text = text.split(secret).join('[秘匿]');
  });
  var wpUser = getProp_('WP_USERNAME');
  var wpPass = getProp_('WP_APP_PASSWORD');
  if (wpUser && wpPass) {
    text = text.split(base64Utf8_(wpUser + ':' + wpPass)).join('[秘匿]');
  }
  text = text.replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[秘匿]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > LIMITS.ERROR_MAX_CHARS ? text.slice(0, LIMITS.ERROR_MAX_CHARS) + '…' : text;
}
