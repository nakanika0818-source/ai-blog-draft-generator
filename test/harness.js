'use strict';
// src/*.gs をGoogle APIのモック付きでNode上に読み込む。実サービスには接続しない。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const LOAD_ORDER = ['Config.gs', 'Sheet.gs', 'Claude.gs', 'Validate.gs', 'Generate.gs', 'WordPress.gs', 'Menu.gs'];

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet.read(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.write(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) {
    this.sheet.write(this.row, this.col, v);
    return this;
  }
  setFontWeight() { return this; }
  setDataValidation() { return this; }
  getRow() { return this.row; }
  getNumRows() { return this.numRows; }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.cells = new Map();
    this.selection = null;
    this.writeLog = [];
    this.maxCols = 26;
  }
  key(r, c) { return r + ':' + c; }
  read(r, c) { const v = this.cells.get(this.key(r, c)); return v === undefined ? '' : v; }
  write(r, c, v) {
    // 実シート同様、先頭の ' は文字列指定として取り除く
    const stored = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
    this.cells.set(this.key(r, c), stored);
    this.writeLog.push({ r, c, v });
  }
  getName() { return this.name; }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  getMaxRows() { return 1000; }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(_, n) { this.maxCols += n; }
  setFrozenRows() {}
  getLastRow() {
    let last = 0;
    for (const k of this.cells.keys()) last = Math.max(last, Number(k.split(':')[0]));
    return last;
  }
  getActiveRangeList() {
    if (!this.selection) return null;
    return { getRanges: () => this.selection.map(([r, n]) => new FakeRange(this, r, 1, n, 1)) };
  }
  select(row, numRows = 1) { this.selection = [[row, numRows]]; }
}

/** 呼び出し順に応答を返すUrlFetchAppのモック。関数を積むと例外も再現できる。 */
function fakeResponse(code, body, headers = {}) {
  return {
    getResponseCode: () => code,
    getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
    getHeaders: () => headers
  };
}

function createEnv(props = {}, { reverseLoad = false } = {}) {
  const sheets = new Map();
  const book = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
    getActiveSheet: () => book.active,
    toast: () => {},
    active: null
  };
  const fetchCalls = [];
  const fetchQueue = [];
  const alerts = [];
  const logs = [];
  let lockAvailable = true;
  const ui = {
    Button: { YES: 'YES', NO: 'NO', OK: 'OK', CANCEL: 'CANCEL' },
    ButtonSet: { YES_NO: 'YES_NO', OK_CANCEL: 'OK_CANCEL' },
    answers: [],
    promptAnswers: [],
    alert: (...args) => { alerts.push(args.join(' | ')); return ui.answers.length ? ui.answers.shift() : 'YES'; },
    prompt: () => {
      const a = ui.promptAnswers.shift();
      return { getSelectedButton: () => a.button, getResponseText: () => a.text };
    },
    createMenu: () => {
      const m = {
        addItem: (_, fn) => { env.menuFunctions.push(fn); return m; },
        addSeparator: () => m,
        addSubMenu: () => m,
        addToUi: () => { env.menuAdded = true; }
      };
      return m;
    }
  };
  const propStore = Object.assign({}, props);
  const sandbox = {
    console: {
      log: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' '))
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => book,
      getUi: () => ui,
      flush: () => {},
      newDataValidation: () => {
        const b = { requireValueInList: () => b, build: () => ({}) };
        return b;
      }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in propStore ? propStore[k] : null)
      })
    },
    LockService: {
      getDocumentLock: () => ({
        tryLock: () => lockAvailable,
        releaseLock: () => {}
      })
    },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' },
      // 文字コード未指定を見逃さないよう、UTF_8以外は別の結果にする
      base64Encode: (s, charset) => Buffer.from(s, charset === 'UTF_8' ? 'utf8' : 'latin1').toString('base64'),
      sleep: () => {}
    },
    UrlFetchApp: {
      fetch: (url, params) => {
        fetchCalls.push({ url, params });
        if (!fetchQueue.length) throw new Error('想定外のHTTP呼び出し: ' + url);
        const next = fetchQueue.shift();
        if (typeof next === 'function') return next(url, params);
        return next;
      }
    }
  };
  vm.createContext(sandbox);
  for (const file of reverseLoad ? [...LOAD_ORDER].reverse() : LOAD_ORDER) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), sandbox, { filename: file });
  }
  const env = {
    gas: sandbox, book, sheets, ui, alerts, logs, fetchCalls, fetchQueue, propStore, menuFunctions: [],
    setLockAvailable: (v) => { lockAvailable = v; },
    /** 見出し入りの管理シートを用意し、アクティブにする */
    newSheet: () => {
      sandbox.prepareSheets_();
      const sheet = sheets.get(sandbox.SHEET_NAME);
      book.active = sheet;
      return sheet;
    }
  };
  return env;
}

/** 条件を満たす記事データ。各段落は目標字数まで埋める。 */
function validArticle(overrides = {}) {
  const para = (seed, n) => (seed + 'について順を追って整理します。').repeat(Math.ceil(n / (seed.length + 14))).slice(0, n) + '。';
  return Object.assign({
    title: 'テスト記事のタイトル',
    meta_description: 'テスト記事の説明文です。',
    intro_paragraphs: [para('導入', 300)],
    section_1: { heading: '見出しその一', paragraphs: [para('第一', 600)] },
    section_2: { heading: '見出しその二', paragraphs: [para('第二', 600)] },
    section_3: { heading: '見出しその三', paragraphs: [para('第三', 600)] },
    summary_paragraphs: [para('総括', 300)],
    fact_check_items: []
  }, overrides);
}

function claudeResponse(article, overrides = {}) {
  return fakeResponse(200, Object.assign({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '', signature: 'x' },
      { type: 'text', text: typeof article === 'string' ? article : JSON.stringify(article) }
    ],
    usage: { input_tokens: 10, output_tokens: 10 }
  }, overrides));
}

module.exports = { createEnv, fakeResponse, validArticle, claudeResponse };
