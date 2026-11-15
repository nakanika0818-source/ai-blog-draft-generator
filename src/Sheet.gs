/** シートの準備と行単位の読み書き。 */

function getManagedSheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new ConfigError_('シート「' + SHEET_NAME + '」がありません。メニューの「シートを準備」を実行してください。');
  assertHeaders_(sheet);
  return sheet;
}

function assertHeaders_(sheet) {
  if (sheet.getMaxColumns() < HEADERS.length) {
    throw new ConfigError_('列が足りません。メニューの「シートを準備」を実行してください。');
  }
  var actual = sheet.getRange(HEADER_ROW, 1, 1, HEADERS.length).getValues()[0];
  for (var i = 0; i < HEADERS.length; i++) {
    if (String(actual[i]).trim() !== HEADERS[i]) {
      throw new ConfigError_('列 ' + (i + 1) + ' の見出しが「' + HEADERS[i] + '」ではありません。列の順番を変更しないでください。');
    }
  }
}

/** 見出しと入力規則を整える。既存の列A〜Gが仕様と違う場合は上書きせず止める。 */
function prepareSheets_() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName(SHEET_NAME) || book.insertSheet(SHEET_NAME);
  if (sheet.getMaxColumns() < HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
  }
  var current = sheet.getRange(HEADER_ROW, 1, 1, HEADERS.length).getValues()[0];
  for (var i = 0; i < HEADERS.length; i++) {
    var value = String(current[i]).trim();
    if (value && value !== HEADERS[i]) {
      throw new ConfigError_('列 ' + (i + 1) + ' に別の見出し「' + value + '」があるため中止しました。');
    }
  }
  sheet.getRange(HEADER_ROW, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(HEADER_ROW);

  var rows = sheet.getMaxRows() - HEADER_ROW;
  if (rows > 0) {
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList([FACT_STATUS.UNCHECKED, FACT_STATUS.CHECKED, FACT_STATUS.NEEDS_FIX], true)
      .build();
    sheet.getRange(HEADER_ROW + 1, COL.FACT_STATUS, rows, 1).setDataValidation(rule);
  }

  var sample = book.getSheetByName(SAMPLE_SHEET_NAME);
  if (!sample) {
    sample = book.insertSheet(SAMPLE_SHEET_NAME);
    sample.getRange(1, 1).setValue('A2以降に文体サンプルを貼り付けてください（文体の参考専用。事実の根拠・転載元にはしません）');
  }
}

/** 選択範囲がちょうど1データ行であることを確かめ、行番号を返す。 */
function getSelectedRow_() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getActiveSheet();
  if (sheet.getName() !== SHEET_NAME) {
    throw new ConfigError_('シート「' + SHEET_NAME + '」で対象の行を選択してください。');
  }
  var ranges = sheet.getActiveRangeList();
  var list = ranges ? ranges.getRanges() : [];
  if (list.length !== 1 || list[0].getNumRows() !== 1) {
    throw new ConfigError_('一度に処理できるのは1行だけです。1行だけ選択してください。');
  }
  var row = list[0].getRow();
  if (row <= HEADER_ROW) throw new ConfigError_('見出し行は処理できません。データ行を選択してください。');
  return row;
}

function readRow_(sheet, rowNumber) {
  var v = sheet.getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];
  return {
    rowNumber: rowNumber,
    keyword: String(v[COL.KEYWORD - 1]).trim(),
    subKeyword: String(v[COL.SUB_KEYWORD - 1]).trim(),
    status: String(v[COL.STATUS - 1]).trim(),
    title: String(v[COL.TITLE - 1]),
    wpUrl: String(v[COL.WP_URL - 1]).trim(),
    body: String(v[COL.BODY - 1]),
    meta: String(v[COL.META - 1]),
    factStatus: String(v[COL.FACT_STATUS - 1]).trim(),
    factItems: String(v[COL.FACT_ITEMS - 1]),
    wpPostId: String(v[COL.WP_POST_ID - 1]).trim(),
    updatedAt: v[COL.UPDATED_AT - 1]
  };
}

/**
 * 指定列だけ書き込み、更新日時を更新して即座に確定する。
 * ステータスは最後に書く。途中で止まっても、中身が揃う前に「生成済み」等にならない。
 */
function writeRow_(sheet, rowNumber, fields) {
  sheet.getRange(rowNumber, COL.UPDATED_AT).setValue(new Date());
  Object.keys(fields).forEach(function (col) {
    if (Number(col) !== COL.STATUS) {
      sheet.getRange(rowNumber, Number(col)).setValue(sheetSafe_(fields[col]));
    }
  });
  if (Object.prototype.hasOwnProperty.call(fields, COL.STATUS)) {
    sheet.getRange(rowNumber, COL.STATUS).setValue(fields[COL.STATUS]);
  }
  SpreadsheetApp.flush();
}

/** AI応答や外部エラーが数式として解釈されないようにする。 */
function sheetSafe_(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function isStale_(row) {
  var updated = row.updatedAt;
  if (Object.prototype.toString.call(updated) !== '[object Date]' || isNaN(updated.getTime())) return true;
  return Date.now() - updated.getTime() > LIMITS.STALE_MINUTES * 60 * 1000;
}

function hasArticle_(row) {
  return Boolean(row.title.trim() || row.body.trim() || row.meta.trim());
}

/** 文体サンプルシートのA2以降を連結して返す。 */
function readStyleSample_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SAMPLE_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return '';
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  var text = values.map(function (r) { return String(r[0]).trim(); }).filter(Boolean).join('\n\n');
  if (Array.from(text).length > LIMITS.SAMPLE_MAX_CHARS) {
    throw new ConfigError_('文体サンプルが ' + LIMITS.SAMPLE_MAX_CHARS + ' 字を超えています。抜粋して減らしてください。');
  }
  return text;
}
