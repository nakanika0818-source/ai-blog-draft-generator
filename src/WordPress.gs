/**
 * 投稿工程。送信するのは title / content / status:'draft' / excerpt だけで、
 * 公開状態を指定する経路は持たない。
 */

var WP_DRAFT_STATUS = 'draft';

function buildWordPressPayload_(row) {
  return {
    title: row.title.trim(),
    content: row.body,
    status: WP_DRAFT_STATUS,
    excerpt: row.meta.trim()
  };
}

function wpAuthHeader_(config) {
  return 'Basic ' + base64Utf8_(config.username + ':' + config.appPassword);
}

function checkCanPost_(row) {
  if (row.wpPostId || row.wpUrl) {
    throw new StageError_(STAGE.POST_INPUT, '投稿IDまたはURLが記録済みのため投稿しません。');
  }
  if (row.status === STATUS.POST_UNKNOWN) {
    throw new StageError_(STAGE.POST_INPUT, '前回の投稿結果が不明です。WordPress管理画面を確認し、「投稿結果を確定」のメニューで処理してください。');
  }
  if (row.status === STATUS.POSTING) {
    throw new StageError_(STAGE.POST_INPUT, '投稿処理中です。完了するまで待ってください。');
  }
  if (row.status !== STATUS.GENERATED && row.status !== STATUS.POST_FAILED) {
    throw new StageError_(STAGE.POST_INPUT, 'ステータスが「' + row.status + '」の行は投稿できません。');
  }
  var errors = validateArticleContent_(row.title, row.body, row.meta);
  if (errors.length) throw new StageError_(STAGE.POST_INPUT, errors.join(' '));
}

/**
 * 応答を分類する。
 * created  : 下書きの作成を確認できた
 * failed   : 作成されていないと判断できる（再投稿してよい）
 * unknown  : 作成された可能性がある（自動再投稿しない）
 */
function classifyWordPressResponse_(code, text) {
  if (code >= 200 && code < 300) {
    var post;
    try {
      post = JSON.parse(text);
    } catch (e) {
      return { kind: 'unknown', message: 'HTTP ' + code + ' ですが応答がJSONではありません。' };
    }
    if (!post || typeof post.id !== 'number' || post.id <= 0) {
      return { kind: 'unknown', message: 'HTTP ' + code + ' ですが投稿IDがありません。' };
    }
    if (post.status !== WP_DRAFT_STATUS) {
      return { kind: 'unknown', id: post.id, link: post.link, message: '投稿ID ' + post.id + ' のstatusが「' + post.status + '」です。至急確認してください。' };
    }
    return { kind: 'created', id: post.id, link: typeof post.link === 'string' ? post.link : '' };
  }
  if (code >= 300 && code < 400) {
    return { kind: 'failed', message: 'HTTP ' + code + ' リダイレクトされました。WP_BASE_URL を確認してください。' };
  }
  if (code === 408 || code >= 500) {
    return { kind: 'unknown', message: 'HTTP ' + code + ' サーバー側で処理された可能性があります。' };
  }
  return { kind: 'failed', message: describeWordPressError_(code, text) };
}

function describeWordPressError_(code, text) {
  try {
    var body = JSON.parse(text);
    return 'HTTP ' + code + ' ' + (body.code || '') + ' ' + (body.message || '');
  } catch (e) {
    return 'HTTP ' + code + '（応答がJSONではありません）';
  }
}

/** 送信本体。例外は結果不明として扱う。WP_SEND_ENABLED の判定は呼び出し元で行う。 */
function sendToWordPress_(config, payload) {
  var response;
  try {
    response = UrlFetchApp.fetch(config.baseUrl + '/wp-json/wp/v2/posts', {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { Authorization: wpAuthHeader_(config) },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: false,
      timeoutSeconds: 60
    });
  } catch (e) {
    return { kind: 'unknown', message: '通信エラーで応答を受け取れませんでした: ' + e.message };
  }
  return classifyWordPressResponse_(response.getResponseCode(), response.getContentText());
}

/** 実送信しない確認用の要約。本文全体は表示せず字数だけ示す。 */
function describeDryRun_(row) {
  var payload = buildWordPressPayload_(row);
  return {
    title: payload.title,
    status: payload.status,
    excerpt: payload.excerpt,
    contentChars: countBodyChars_(payload.content)
  };
}

/**
 * 投稿工程の本体。ロック取得後に呼ぶ。
 * 送信前に「投稿中」を確定し、途中で止まっても再投稿されないようにする。
 */
function runPost_(sheet, rowNumber) {
  var row = readRow_(sheet, rowNumber);

  if (row.status === STATUS.POSTING && isStale_(row)) {
    var stale = {};
    stale[COL.STATUS] = STATUS.POST_UNKNOWN;
    stale[COL.FAILED_STAGE] = STAGE.POST_RECOVERY;
    stale[COL.ERROR] = '前回の投稿処理が結果を記録せず中断しました。WordPress管理画面を確認してください。';
    writeRow_(sheet, rowNumber, stale);
    return { ok: false, kind: 'unknown', stage: STAGE.POST_RECOVERY, message: stale[COL.ERROR] };
  }

  checkCanPost_(row);

  if (!isWpSendEnabled_()) {
    // 実送信オフ時は、送るはずだった4項目を実行ログに残す（認証情報は含まない）。
    console.log('[送信テスト ' + rowNumber + '行目] 実送信していません。送信予定の内容:\n' +
      JSON.stringify(buildWordPressPayload_(row), null, 2));
    return { ok: true, kind: 'dry_run', preview: describeDryRun_(row) };
  }

  var config = getWordPressConfig_();
  var payload = buildWordPressPayload_(row);

  var claim = {};
  claim[COL.STATUS] = STATUS.POSTING;
  claim[COL.FAILED_STAGE] = '';
  claim[COL.ERROR] = '';
  writeRow_(sheet, rowNumber, claim);

  var result = sendToWordPress_(config, payload);
  var fields = {};
  if (result.kind === 'created') {
    fields[COL.STATUS] = STATUS.POSTED;
    fields[COL.WP_POST_ID] = result.id;
    fields[COL.WP_URL] = result.link;
    fields[COL.FAILED_STAGE] = '';
    fields[COL.ERROR] = '';
    writeRow_(sheet, rowNumber, fields);
    return { ok: true, kind: 'created', id: result.id, link: result.link };
  }

  var message = sanitizeMessage_(result.message);
  fields[COL.STATUS] = result.kind === 'failed' ? STATUS.POST_FAILED : STATUS.POST_UNKNOWN;
  fields[COL.FAILED_STAGE] = STAGE.POST_API;
  fields[COL.ERROR] = message;
  if (result.id) fields[COL.WP_POST_ID] = result.id;
  if (result.link) fields[COL.WP_URL] = result.link;
  writeRow_(sheet, rowNumber, fields);
  return { ok: false, kind: result.kind, stage: STAGE.POST_API, message: message };
}

/** 投稿結果不明の行を、人が確認した投稿IDで確定する。IDは読み取りで検証する。 */
function resolveUnknownAsPosted_(sheet, rowNumber, postIdText) {
  var row = readRow_(sheet, rowNumber);
  if (row.status !== STATUS.POST_UNKNOWN) {
    throw new StageError_(STAGE.POST_RECOVERY, 'ステータスが「' + STATUS.POST_UNKNOWN + '」の行だけ確定できます。');
  }
  if (!/^[1-9][0-9]*$/.test(String(postIdText).trim())) {
    throw new StageError_(STAGE.POST_RECOVERY, '投稿IDは正の整数で入力してください。');
  }
  var config = getWordPressConfig_();
  var response = UrlFetchApp.fetch(config.baseUrl + '/wp-json/wp/v2/posts/' + String(postIdText).trim() + '?context=edit', {
    method: 'get',
    headers: { Authorization: wpAuthHeader_(config) },
    muteHttpExceptions: true,
    followRedirects: false,
    timeoutSeconds: 30
  });
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code !== 200) throw new StageError_(STAGE.POST_RECOVERY, sanitizeMessage_(describeWordPressError_(code, text)));
  var post;
  try {
    post = JSON.parse(text);
  } catch (e) {
    throw new StageError_(STAGE.POST_RECOVERY, '応答がJSONではありません。');
  }
  var fields = {};
  fields[COL.STATUS] = STATUS.POSTED;
  fields[COL.WP_POST_ID] = post.id;
  fields[COL.WP_URL] = typeof post.link === 'string' ? post.link : '';
  fields[COL.FAILED_STAGE] = '';
  fields[COL.ERROR] = post.status === WP_DRAFT_STATUS ? '' : '確認時のWordPress上のstatus: ' + post.status;
  writeRow_(sheet, rowNumber, fields);
  var wpTitle = post.title && (post.title.raw || post.title.rendered) || '';
  return { id: post.id, status: post.status, title: wpTitle, link: fields[COL.WP_URL] };
}

/** 人が「作成されていない」と確認した行を再投稿できる状態へ戻す。 */
function resolveUnknownAsNotPosted_(sheet, rowNumber) {
  var row = readRow_(sheet, rowNumber);
  if (row.status !== STATUS.POST_UNKNOWN) {
    throw new StageError_(STAGE.POST_RECOVERY, 'ステータスが「' + STATUS.POST_UNKNOWN + '」の行だけ処理できます。');
  }
  if (row.wpPostId) {
    throw new StageError_(STAGE.POST_RECOVERY, '投稿ID ' + row.wpPostId + ' が記録されているため未投稿にはできません。');
  }
  var fields = {};
  fields[COL.STATUS] = STATUS.POST_FAILED;
  fields[COL.FAILED_STAGE] = STAGE.POST_RECOVERY;
  fields[COL.ERROR] = '人の確認により未投稿と判断。再投稿できます。';
  writeRow_(sheet, rowNumber, fields);
}

/** 確認を助ける読み取り専用の検索。同じタイトルの下書きを探す。 */
function searchDraftCandidates_(title) {
  if (!title) throw new StageError_(STAGE.POST_RECOVERY, 'タイトルが空のため検索できません。');
  var config = getWordPressConfig_();
  var url = config.baseUrl + '/wp-json/wp/v2/posts?context=edit&status=draft&per_page=10&search=' + encodeURIComponent(title);
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: wpAuthHeader_(config) },
    muteHttpExceptions: true,
    followRedirects: false,
    timeoutSeconds: 30
  });
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code !== 200) throw new StageError_(STAGE.POST_RECOVERY, sanitizeMessage_(describeWordPressError_(code, text)));
  var posts;
  try {
    posts = JSON.parse(text);
  } catch (e) {
    throw new StageError_(STAGE.POST_RECOVERY, '応答がJSONではありません。');
  }
  return posts.map(function (p) {
    return { id: p.id, title: p.title && (p.title.raw || p.title.rendered) || '', date: p.date };
  });
}

/** 認証の確認。書き込みは行わない。 */
function testWordPressConnection_() {
  var config = getWordPressConfig_();
  var response = UrlFetchApp.fetch(config.baseUrl + '/wp-json/wp/v2/users/me?context=edit', {
    method: 'get',
    headers: { Authorization: wpAuthHeader_(config) },
    muteHttpExceptions: true,
    followRedirects: false,
    timeoutSeconds: 30
  });
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code !== 200) throw new StageError_('WordPress接続テスト', sanitizeMessage_(describeWordPressError_(code, text)));
  var user;
  try {
    user = JSON.parse(text);
  } catch (e) {
    throw new StageError_('WordPress接続テスト', '応答がJSONではありません。');
  }
  var caps = user.capabilities || {};
  return { name: user.name, canEditPosts: Boolean(caps.edit_posts) };
}
