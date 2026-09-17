from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'missing patch anchor: {label}')
    return text.replace(old, new, 1)

entry_path = Path('src/entry.js')
entry = entry_path.read_text()
entry = replace_once(
    entry,
    "const EVIDENCE_REQUIRED_RE = /(おすすめ|候補|店|店舗|販売店|会社|企業|法人|施設|病院|医院|クリニック|ホテル|旅館|飲食店|レストラン|カフェ|商品|製品|型番|モデル|仕様|互換|対応|住所|所在地|電話番号|連絡先|営業時間|予約|アクセス|最寄り|実在|存在|価格|値段|相場|在庫|発売|最新|現在|今日|明日|ニュース|運行|時刻表|天気|為替|法律|制度|バージョン)/i;",
    "const EVIDENCE_REQUIRED_RE = /(おすすめ|候補|店|店舗|販売店|会社|企業|法人|施設|病院|医院|クリニック|ホテル|旅館|飲食店|レストラン|カフェ|商品|製品|型番|モデル|仕様|互換|対応|住所|所在地|電話番号|連絡先|営業時間|予約|アクセス|最寄り|実在|存在|価格|値段|相場|在庫|発売|最新|現在|今日|明日|ニュース|運行|時刻表|天気|為替|法律|制度|バージョン)/i;\nconst ENTITY_RECOMMENDATION_RE = /(おすすめ|候補|店|店舗|販売店|会社|企業|法人|施設|病院|医院|クリニック|ホテル|旅館|飲食店|レストラン|カフェ|住所|所在地|電話番号|連絡先|営業時間|予約|アクセス|最寄り|実在|存在)/i;",
    'entity recommendation risk class',
)
entry = replace_once(
    entry,
    """  if (EVIDENCE_REQUIRED_RE.test(question)) {
    if (!hasEvidence) {
      if (answer) reasons.push('evidence_required_but_missing');
      answer = '今回取得できた根拠では、実在や条件適合を確認できる具体候補を挙げられませんでした。';
    } else {
      const guarded = removeUnsupportedNamedEntities(answer, payload, question);
      if (guarded !== answer) reasons.push('named_entities_require_matching_evidence');
      answer = guarded || '取得できた根拠の範囲では、具体名を安全に確認できませんでした。';
    }
  }""",
    """  if (EVIDENCE_REQUIRED_RE.test(question)) {
    if (!hasEvidence && ENTITY_RECOMMENDATION_RE.test(question)) {
      if (answer) reasons.push('entity_evidence_required_but_missing');
      answer = '今回取得できた根拠では、実在や条件適合を確認できる具体候補を挙げられませんでした。';
    } else if (hasEvidence) {
      const guarded = removeUnsupportedNamedEntities(answer, payload, question);
      if (guarded !== answer) reasons.push('named_entities_require_matching_evidence');
      answer = guarded || '取得できた根拠の範囲では、具体名を安全に確認できませんでした。';
    }
  }""",
    'preserve safe stable/user supplied facts when only dynamic evidence is missing',
)
entry_path.write_text(entry)

worker_path = Path('src/worker-v44.js')
worker = worker_path.read_text()
worker = replace_once(
    worker,
    """  if (!value) return false;
  if (NO_EXTERNAL_RE.test(value)) return false;
  if (TRIVIAL_RE.test(value) || FEELING_ONLY_RE.test(value) || MEMORY_ONLY_RE.test(value) || CAPABILITY_RE.test(value)) return false;
  const evidenceRisk = EXPLICIT_LOOKUP_RE.test(value) || DYNAMIC_FACT_RE.test(value) || REAL_WORLD_ENTITY_RE.test(value) || RECOMMENDATION_RE.test(value);
  if (evidenceRisk) return true;
  if (SUBJECTIVE_RE.test(value)) return false;
  if (LOCAL_TRANSFORM_RE.test(value) || LOCAL_ADVICE_RE.test(value)) return false;""",
    """  if (!value) return false;
  if (NO_EXTERNAL_RE.test(value)) return false;
  const evidenceRisk = EXPLICIT_LOOKUP_RE.test(value) || DYNAMIC_FACT_RE.test(value) || REAL_WORLD_ENTITY_RE.test(value) || RECOMMENDATION_RE.test(value);
  if (evidenceRisk) return true;
  if (TRIVIAL_RE.test(value) || FEELING_ONLY_RE.test(value) || MEMORY_ONLY_RE.test(value) || CAPABILITY_RE.test(value) || SUBJECTIVE_RE.test(value)) return false;
  if (LOCAL_TRANSFORM_RE.test(value) || LOCAL_ADVICE_RE.test(value)) return false;""",
    'high risk factual intent before trivial subjective bypass',
)
worker_path.write_text(worker)

print('refined v54 fail-closed policy')
