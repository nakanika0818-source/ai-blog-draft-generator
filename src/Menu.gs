/** カスタムメニューと利用者向けの入口。 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('記事生成')
    .addItem('選択行の記事を生成', 'menuGenerate')
    .addItem('選択行を再生成（上書き確認あり）', 'menuRegenerate')
    .addSeparator()
    .addItem('選択行をWordPressへ下書き投稿', 'menuPost')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('投稿結果を確定（結果不明の行）')
      .addItem('同じタイトルの下書きを検索', 'menuSearchDraft')
      .addItem('投稿されていた（IDを入力）', 'menuResolvePosted')
      .addItem('投稿されていなかった（再投稿を許可）', 'menuResolveNotPosted'))
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('設定')
      .addItem('シートを準備', 'menuPrepare')
      .addItem('設定を確認（通信なし）', 'menuCheckConfig')
      .addItem('Claude接続テスト', 'menuTestClaude')
      .addItem('WordPress接続テスト', 'menuTestWordPress'))
    .addToUi();
}

/** 同時実行を防ぐ。ロックは処理の最後まで保持し、取れなければ何もしない。 */
function withDocumentLock_(fn) {
  var lock = LockService.getDocumentLock();
  if (!lock || !lock.tryLock(1000)) {
    SpreadsheetApp.getUi().alert('別の処理が実行中です。完了してからもう一度実行してください。');
    return;
  }
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}

/** 想定内の失敗はダイアログで伝える。ログには秘密情報を除いた内容だけを出す。 */
function runMenuAction_(fn) {
  var ui = SpreadsheetApp.getUi();
  try {
    withDocumentLock_(fn);
  } catch (e) {
    var message = sanitizeMessage_(e.message);
    console.error('メニュー処理エラー: ' + (e.stage || e.name) + ': ' + message);
    ui.alert('処理を中止しました\n\n' + (e.stage ? '工程: ' + e.stage + '\n' : '') + message);
  }
}

function menuGenerate() { generateSelected_(false, Date.now()); }

function menuRegenerate() {
  // 確認ダイアログの待ち時間もGASの実行時間に含まれるので、開始時刻はここで取る。
  var startMs = Date.now();
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert('再生成の確認', '選択行のタイトル・本文・説明文を、新しい生成結果で上書きします。人が編集した内容も失われます。続行しますか？', ui.ButtonSet.YES_NO);
  if (answer === ui.Button.YES) generateSelected_(true, startMs);
}

function generateSelected_(allowOverwrite, startMs) {
  runMenuAction_(function () {
    var ui = SpreadsheetApp.getUi();
    var rowNumber = getSelectedRow_();
    var sheet = getManagedSheet_();
    var row = readRow_(sheet, rowNumber);
    checkCanGenerate_(row, allowOverwrite);
    var styleSample = readStyleSample_();
    if (!styleSample) {
      var answer = ui.alert('文体サンプルなし', 'シート「' + SAMPLE_SHEET_NAME + '」が空です。文体の参考なしで生成しますか？', ui.ButtonSet.YES_NO);
      if (answer !== ui.Button.YES) return;
    }
    SpreadsheetApp.getActiveSpreadsheet().toast('生成しています。最大で数分かかります。', '記事生成', 30);

    var result = runGenerate_(sheet, rowNumber, allowOverwrite, styleSample, startMs);
    if (result.ok) {
      ui.alert('生成しました（' + rowNumber + '行目）\n\n本文 ' + result.bodyChars + ' 字 / 説明文 ' + result.metaChars + ' 字 / 試行 ' + result.attempts + ' 回\n\n事実確認は未実施です。I列の要確認事項を確認し、H列に結果を記入してください。');
    } else {
      ui.alert('生成に失敗しました（' + rowNumber + '行目）\n\n工程: ' + result.stage + '\n' + result.message +
        (result.keptPrevious ? '\n\n以前の記事はそのまま残っています。' : ''));
    }
  });
}

function menuPost() {
  runMenuAction_(function () {
    var ui = SpreadsheetApp.getUi();
    var rowNumber = getSelectedRow_();
    var sheet = getManagedSheet_();
    var row = readRow_(sheet, rowNumber);

    if (isWpSendEnabled_() && row.status !== STATUS.POSTING) {
      checkCanPost_(row);
      var note = row.factStatus === FACT_STATUS.CHECKED ? '' : '\n\n事実確認は「確認済み」になっていません。公開前に必ず確認してください。';
      var answer = ui.alert('投稿の確認', '「' + row.title.trim() + '」をWordPressへ下書きとして送信します。公開はされません。' + note, ui.ButtonSet.OK_CANCEL);
      if (answer !== ui.Button.OK) return;
    }

    var result = runPost_(sheet, rowNumber);
    if (result.kind === 'dry_run') {
      var p = result.preview;
      ui.alert('送信テスト（実送信していません）\n\nWP_SEND_ENABLED が true ではないため、WordPressへは接続していません。\n\n' +
        'title: ' + p.title + '\nstatus: ' + p.status + '\nexcerpt: ' + p.excerpt + '\ncontent: ' + p.contentChars + ' 字');
    } else if (result.kind === 'created') {
      ui.alert('下書きを作成しました\n\n投稿ID: ' + result.id + '\nURL: ' + result.link);
    } else if (result.kind === 'unknown') {
      ui.alert('投稿結果が不明です。自動では再投稿しません。\n\n' + result.message + '\n\nWordPress管理画面を確認し、メニューの「投稿結果を確定」で処理してください。');
    } else {
      ui.alert('投稿に失敗しました（下書きは作成されていません）\n\n' + result.message + '\n\n原因を解消して、もう一度投稿できます。');
    }
  });
}

function menuSearchDraft() {
  runMenuAction_(function () {
    var row = readRow_(getManagedSheet_(), getSelectedRow_());
    var posts = searchDraftCandidates_(row.title.trim());
    var lines = posts.map(function (p) { return 'ID ' + p.id + ' / ' + p.date + ' / ' + p.title; });
    SpreadsheetApp.getUi().alert('下書きの検索結果（' + posts.length + ' 件）\n\n' + (lines.join('\n') || '見つかりませんでした。') +
      '\n\n検索結果だけで判断せず、管理画面で内容を確認してください。');
  });
}

function menuResolvePosted() {
  runMenuAction_(function () {
    var ui = SpreadsheetApp.getUi();
    var rowNumber = getSelectedRow_();
    var input = ui.prompt('投稿IDの入力', 'WordPress管理画面で確認した投稿IDを入力してください。', ui.ButtonSet.OK_CANCEL);
    if (input.getSelectedButton() !== ui.Button.OK) return;
    var result = resolveUnknownAsPosted_(getManagedSheet_(), rowNumber, input.getResponseText());
    ui.alert('確定しました\n\n投稿ID: ' + result.id + '\nWordPress上のタイトル: ' + result.title + '\nWordPress上のstatus: ' + result.status);
  });
}

function menuResolveNotPosted() {
  runMenuAction_(function () {
    var ui = SpreadsheetApp.getUi();
    var rowNumber = getSelectedRow_();
    var answer = ui.alert('未投稿の確定', 'WordPress管理画面で、この記事の下書きがないことを確認しましたか？再投稿できる状態に戻します。', ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) return;
    resolveUnknownAsNotPosted_(getManagedSheet_(), rowNumber);
    ui.alert('「' + STATUS.POST_FAILED + '」に戻しました。メニューから再投稿できます。');
  });
}

function menuPrepare() {
  runMenuAction_(function () {
    prepareSheets_();
    SpreadsheetApp.getUi().alert('シートを準備しました。');
  });
}

/** 値は表示せず、設定の有無だけを返す。 */
function describeConfigStatus_() {
  function state(name) { return name + ': ' + (getProp_(name) ? '設定済み' : '未設定'); }
  function value(name, fallback) { return name + ': ' + (getProp_(name) || fallback + '（既定値）'); }
  return [
    state('ANTHROPIC_API_KEY'),
    'ANTHROPIC_WORKSPACE_ID: ' + (getProp_('ANTHROPIC_WORKSPACE_ID') || '未設定（ワークスペースに紐づくキーなら不要）'),
    value('CLAUDE_MODEL', DEFAULTS.CLAUDE_MODEL),
    value('CLAUDE_EFFORT', DEFAULTS.CLAUDE_EFFORT),
    value('CLAUDE_MAX_TOKENS', DEFAULTS.CLAUDE_MAX_TOKENS),
    value('CLAUDE_FALLBACKS', DEFAULTS.CLAUDE_FALLBACKS),
    value('GEN_MAX_ATTEMPTS', DEFAULTS.GEN_MAX_ATTEMPTS),
    '',
    'WP_SEND_ENABLED: ' + (isWpSendEnabled_() ? 'true（実送信します）' : 'false（実送信しません）'),
    state('WP_BASE_URL'),
    state('WP_USERNAME'),
    state('WP_APP_PASSWORD')
  ].join('\n');
}

function menuCheckConfig() {
  runMenuAction_(function () {
    SpreadsheetApp.getUi().alert('現在の設定\n\n' + describeConfigStatus_());
  });
}

function menuTestClaude() {
  runMenuAction_(function () {
    var model = testClaudeConnection_();
    SpreadsheetApp.getUi().alert('Claude接続テスト成功\n\nモデル: ' + model.id + '（' + model.displayName + '）\n記事生成は行っていません。');
  });
}

function menuTestWordPress() {
  runMenuAction_(function () {
    var user = testWordPressConnection_();
    SpreadsheetApp.getUi().alert('WordPress接続テスト成功\n\nユーザー: ' + user.name + '\n投稿編集権限: ' + (user.canEditPosts ? 'あり' : 'なし') + '\n投稿は行っていません。');
  });
}
