/** 生成工程。検証を通った記事だけをシートへ書き込む。 */

/** 生成してよい状態か判定する。allowOverwrite は再生成メニューからのみ true。 */
function checkCanGenerate_(row, allowOverwrite) {
  if (!row.keyword) throw new StageError_(STAGE.GEN_INPUT, 'A列のキーワードが空です。');

  if (row.wpPostId || row.wpUrl) {
    throw new StageError_(STAGE.GEN_INPUT, 'WordPressへ投稿済みの情報がある行は再生成できません。新しい行で作成してください。');
  }
  switch (row.status) {
    case STATUS.POSTING:
    case STATUS.POST_UNKNOWN:
    case STATUS.POSTED:
      throw new StageError_(STAGE.GEN_INPUT, 'ステータスが「' + row.status + '」の行は再生成できません。');
    case STATUS.GENERATING:
      if (!isStale_(row)) throw new StageError_(STAGE.GEN_INPUT, '生成中です。完了するまで待ってください。');
      break;
    case STATUS.EMPTY:
    case STATUS.GENERATED:
    case STATUS.GENERATE_FAILED:
    case STATUS.POST_FAILED:
      break;
    default:
      throw new StageError_(STAGE.GEN_INPUT, '不明なステータス「' + row.status + '」です。');
  }
  if (hasArticle_(row) && !allowOverwrite) {
    throw new StageError_(STAGE.GEN_INPUT, '生成済みの記事があるため上書きしません。作り直す場合は「選択行を再生成」を使ってください。');
  }
}

/**
 * 記事を1件生成する。
 * 戻り値 { article, html, model, attempts }。違反があれば再度作り直し、最後は StageError_。
 */
function generateArticle_(config, row, styleSample, startMs) {
  var deadlineMs = startMs + LIMITS.EXECUTION_BUDGET_MS;
  var feedback = '';
  var lastErrors = [];

  for (var attempt = 1; attempt <= config.maxAttempts; attempt++) {
    var result = callClaude_(config, row, styleSample, feedback, deadlineMs);
    var errors = validateArticleShape_(result.article);
    var html = '';
    if (!errors.length) {
      html = buildArticleHtml_(result.article);
      errors = validateArticleContent_(result.article.title, html, result.article.meta_description);
      var copied = findCopiedRun_(html, styleSample);
      if (copied) errors.push('文体サンプルと一致する文があります: 「' + copied + '」');
    }
    if (!errors.length) {
      return { article: result.article, html: html, model: result.model, attempts: attempt };
    }

    lastErrors = errors;
    feedback = errors.join('\n');
    if (deadlineMs - Date.now() < LIMITS.MIN_REMAINING_MS) break;
  }
  throw new StageError_(STAGE.GEN_VALIDATE, lastErrors.join(' '));
}

/**
 * 生成工程の本体。ロック取得後に呼ぶ。
 * 失敗時もシートへ記録してから { ok:false } を返し、利用者に結果を伝える。
 */
function runGenerate_(sheet, rowNumber, allowOverwrite, styleSample, startMs) {
  var row = readRow_(sheet, rowNumber);
  checkCanGenerate_(row, allowOverwrite);
  var config = getClaudeConfig_();
  var priorStatus = row.status;
  var hadArticle = hasArticle_(row) && (priorStatus === STATUS.GENERATED || priorStatus === STATUS.POST_FAILED);

  var claim = {};
  claim[COL.STATUS] = STATUS.GENERATING;
  claim[COL.FAILED_STAGE] = '';
  claim[COL.ERROR] = '';
  writeRow_(sheet, rowNumber, claim);

  try {
    var generated = generateArticle_(config, row, styleSample, startMs);
    var scanned = scanFactCandidates_(generated.html);

    var done = {};
    done[COL.TITLE] = generated.article.title.trim();
    done[COL.BODY] = generated.html;
    done[COL.META] = generated.article.meta_description.trim();
    done[COL.FACT_STATUS] = FACT_STATUS.UNCHECKED;
    done[COL.FACT_ITEMS] = formatFactItems_(generated.article.fact_check_items, scanned);
    done[COL.MODEL] = generated.model;
    done[COL.FAILED_STAGE] = '';
    done[COL.ERROR] = '';
    done[COL.STATUS] = STATUS.GENERATED;
    writeRow_(sheet, rowNumber, done);

    return {
      ok: true,
      attempts: generated.attempts,
      bodyChars: countBodyChars_(generated.html),
      metaChars: countChars_(generated.article.meta_description.trim())
    };
  } catch (e) {
    var stage = e.stage || STAGE.GEN_API;
    var message = sanitizeMessage_(e.message);
    var failed = {};
    // 再生成に失敗しても、直前の記事は有効なので元の状態へ戻す。
    failed[COL.STATUS] = hadArticle ? priorStatus : STATUS.GENERATE_FAILED;
    failed[COL.FAILED_STAGE] = stage;
    failed[COL.ERROR] = message;
    writeRow_(sheet, rowNumber, failed);
    return { ok: false, stage: stage, message: message, keptPrevious: hadArticle };
  }
}
