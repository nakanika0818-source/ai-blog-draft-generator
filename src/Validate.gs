/** 記事の組み立てと検証。Google APIに依存しないのでNodeでテストできる。 */

function escapeHtml_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeHtml_(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function paragraphsToHtml_(paragraphs) {
  return paragraphs.map(function (p) { return '<p>' + escapeHtml_(String(p).trim()) + '</p>'; }).join('\n');
}

function sectionsOf_(article) {
  return [article.section_1, article.section_2, article.section_3];
}

/** 構造化データからWordPress用HTMLを作る。AIの文字列はすべてエスケープする。 */
function buildArticleHtml_(article) {
  var parts = [paragraphsToHtml_(article.intro_paragraphs)];
  sectionsOf_(article).forEach(function (s) {
    parts.push('<h2>' + escapeHtml_(String(s.heading).trim()) + '</h2>');
    parts.push(paragraphsToHtml_(s.paragraphs));
  });
  parts.push('<h2>' + SUMMARY_HEADING + '</h2>');
  parts.push(paragraphsToHtml_(article.summary_paragraphs));
  return parts.join('\n');
}

/** 本文文字数: タグと空白を除いた見出し込みの可視文字をコードポイント単位で数える。 */
function countBodyChars_(html) {
  var text = unescapeHtml_(String(html).replace(/<[^>]*>/g, ''));
  return Array.from(text.replace(/\s/g, '')).length;
}

function countChars_(text) {
  return Array.from(String(text)).length;
}

function extractH2s_(html) {
  var out = [];
  var re = /<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi;
  var m;
  while ((m = re.exec(html)) !== null) out.push(m[1].replace(/<[^>]*>/g, '').trim());
  return out;
}

/** AI出力の形を確かめる。スキーマで縛れない内容面の違反を返す。 */
function validateArticleShape_(article) {
  var errors = [];
  if (!article || typeof article !== 'object') return ['記事データがオブジェクトではありません。'];

  function checkText(label, value) {
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(label + 'が空です。');
    } else if (/<[a-zA-Z\/!][^>]*>/.test(value)) {
      errors.push(label + 'にHTMLタグが含まれています。');
    } else if (/(^|\n)\s*(#{1,6}\s|[-*]\s)|\*\*/.test(value)) {
      errors.push(label + 'にMarkdown記号が含まれています。');
    }
  }
  function checkParagraphs(label, value) {
    if (!Array.isArray(value) || value.length === 0) {
      errors.push(label + 'がありません。');
      return;
    }
    value.forEach(function (p, i) { checkText(label + (i + 1), p); });
  }

  checkText('タイトル', article.title);
  checkText('メタディスクリプション', article.meta_description);
  checkParagraphs('導入', article.intro_paragraphs);
  sectionsOf_(article).forEach(function (s, i) {
    var label = '見出し' + (i + 1);
    if (!s || typeof s !== 'object') {
      errors.push(label + 'のセクションがありません。');
      return;
    }
    checkText(label, s.heading);
    checkParagraphs(label + 'の段落', s.paragraphs);
    if (typeof s.heading === 'string' && s.heading.trim() === SUMMARY_HEADING) {
      errors.push(label + 'に「' + SUMMARY_HEADING + '」は使えません。');
    }
  });
  checkParagraphs('まとめ', article.summary_paragraphs);
  if (!Array.isArray(article.fact_check_items)) {
    errors.push('fact_check_items が配列ではありません。');
  } else if (article.fact_check_items.some(function (item) { return !item || typeof item.claim !== 'string'; })) {
    errors.push('fact_check_items の形式が不正です。');
  }
  return errors;
}

/** 完成したHTMLの検証。生成直後と、人が編集した後の投稿直前の両方で使う。 */
function validateArticleContent_(title, html, meta) {
  var errors = [];
  if (!String(title).trim()) errors.push('タイトルが空です。');
  if (/[\r\n]/.test(String(title).trim())) errors.push('タイトルに改行が含まれています。');

  var metaChars = countChars_(String(meta).trim());
  if (metaChars === 0) errors.push('メタディスクリプションが空です。');
  if (metaChars > LIMITS.META_MAX_CHARS) {
    errors.push('メタディスクリプションが ' + metaChars + ' 字です（上限 ' + LIMITS.META_MAX_CHARS + ' 字）。');
  }

  var bodyChars = countBodyChars_(html);
  if (bodyChars < LIMITS.BODY_MIN_CHARS || bodyChars > LIMITS.BODY_MAX_CHARS) {
    errors.push('本文が ' + bodyChars + ' 字です（' + LIMITS.BODY_MIN_CHARS + '〜' + LIMITS.BODY_MAX_CHARS + ' 字）。');
  }

  var unsafeTag = (String(html).match(/<[^>]*>/g) || []).some(function (tag) {
    return /^<\s*(script|iframe|object|embed|style)\b/i.test(tag) ||
      /\son[a-z]+\s*=/i.test(tag) ||
      /(href|src)\s*=\s*["']?\s*javascript:/i.test(tag);
  });
  if (unsafeTag) errors.push('本文に使用できないHTMLが含まれています。');

  var h2s = extractH2s_(html);
  var last = h2s.length ? h2s[h2s.length - 1] : '';
  if (last !== SUMMARY_HEADING) errors.push('最後の見出しが「' + SUMMARY_HEADING + '」ではありません。');
  var mainCount = h2s.filter(function (h) { return h !== SUMMARY_HEADING; }).length;
  if (mainCount !== LIMITS.BODY_H2_COUNT || h2s.length !== LIMITS.BODY_H2_COUNT + 1) {
    errors.push('本論のH2が ' + mainCount + ' 個です（' + LIMITS.BODY_H2_COUNT + ' 個＋' + SUMMARY_HEADING + '）。');
  }

  var firstH2 = String(html).search(/<h2\b/i);
  var intro = firstH2 === -1 ? '' : String(html).slice(0, firstH2);
  if (firstH2 !== -1 && !intro.replace(/<[^>]*>/g, '').trim()) errors.push('最初の見出しの前に導入がありません。');

  return errors;
}

/** サンプルと一定文字数以上一致する箇所を探す（転載の検出）。 */
function findCopiedRun_(html, sample) {
  if (!sample) return '';
  var n = LIMITS.COPY_RUN_CHARS;
  var normalize = function (s) { return Array.from(String(s).replace(/\s/g, '')); };
  var sampleChars = normalize(sample);
  if (sampleChars.length < n) return '';
  var seen = {};
  for (var i = 0; i + n <= sampleChars.length; i++) seen['k' + sampleChars.slice(i, i + n).join('')] = true;

  var bodyChars = normalize(unescapeHtml_(String(html).replace(/<[^>]*>/g, '\n')));
  for (var j = 0; j + n <= bodyChars.length; j++) {
    var candidate = bodyChars.slice(j, j + n).join('');
    if (seen['k' + candidate]) return candidate;
  }
  return '';
}

/**
 * 要事実確認の語句を機械的に拾う。AIの自己申告だけに頼らないための補助で、
 * 該当しないことは事実確認済みを意味しない。
 */
var FACT_PATTERNS = [
  { label: '法令', re: /[^。\n]*(法律|法令|法改正|条例|政令|省令|協定|特別条項|義務|罰則|罰金|懲役|割増賃金|時間外労働|上限規制|第[0-9０-９一二三四五六七八九十百]+条|[一-龥ァ-ヶ]{2,}(?<![方手文作用技寸魔療工製商説])法(?=[がはをにでとの、。]))[^。\n]*。?/g },
  { label: '料金', re: /[^。\n]*([0-9０-９,，]+\s*(円|ドル)|料金|価格|税込|税抜|無料|月額|年額)[^。\n]*。?/g },
  { label: '統計・数値', re: /[^。\n]*([0-9０-９.．]+\s*[%％]|[0-9０-９,，]+\s*(万|億)?\s*(人|件|社|時間|日|か月|ヶ月|カ月))[^。\n]*。?/g },
  { label: '日付', re: /[^。\n]*((19|20)[0-9]{2}\s*年|令和\s*[0-9０-９元]+\s*年|[0-9０-９]+\s*月\s*[0-9０-９]+\s*日)[^。\n]*。?/g },
  { label: '製品機能', re: /[^。\n]*(機能|仕様|対応しています|搭載|バージョン)[^。\n]*。?/g }
];

function scanFactCandidates_(html) {
  var text = unescapeHtml_(String(html).replace(/<\/(p|h2)>/gi, '\n').replace(/<[^>]*>/g, ''));
  var found = [];
  var seen = {};
  FACT_PATTERNS.forEach(function (pattern) {
    var matches = text.match(pattern.re) || [];
    matches.forEach(function (sentence) {
      var key = pattern.label + '|' + sentence.trim();
      if (sentence.trim() && !seen[key]) {
        seen[key] = true;
        found.push({ category: pattern.label, claim: sentence.trim() });
      }
    });
  });
  return found;
}

/** 「要確認事項」列の文面を作る。AI申告と機械検出を区別して残す。 */
function formatFactItems_(aiItems, scanned) {
  var lines = [];
  (aiItems || []).forEach(function (item) {
    lines.push('[AI申告/' + item.category + '] ' + item.claim);
  });
  (scanned || []).forEach(function (item) {
    lines.push('[機械検出/' + item.category + '] ' + item.claim);
  });
  if (!lines.length) return '検出なし（未検出であり、事実確認済みではありません）';
  var text = lines.join('\n');
  return countChars_(text) > 40000 ? Array.from(text).slice(0, 40000).join('') + '\n…（以下省略）' : text;
}
