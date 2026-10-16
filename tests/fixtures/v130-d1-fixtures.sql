-- Synthetic V130 integration fixtures. Never copy production caller data into staging.

INSERT INTO phone_calls(call_id,from_number,to_number,status,started_at,updated_at,ended_at,message_count)
VALUES
  ('fx-first-1','+819000000001','+815000000000','ended','2026-10-15T00:00:00Z','2026-10-15T00:01:00Z','2026-10-15T00:01:00Z',2),
  ('fx-profile-1','+819000000002','+815000000000','ended','2026-10-15T00:02:00Z','2026-10-15T00:03:00Z','2026-10-15T00:03:00Z',2),
  ('fx-backlog-1','+819000000003','+815000000000','ended','2026-10-15T00:04:00Z','2026-10-15T00:20:00Z','2026-10-15T00:20:00Z',30),
  ('fx-multi-1','+819000000004','+815000000000','ended','2026-10-15T00:21:00Z','2026-10-15T00:22:00Z','2026-10-15T00:22:00Z',2),
  ('fx-multi-2','+819000000004','+815000000000','ended','2026-10-15T00:23:00Z','2026-10-15T00:24:00Z','2026-10-15T00:24:00Z',2),
  ('fx-trash-1','+819000000007','+815000000000','ended','2026-10-15T00:25:00Z','2026-10-15T00:26:00Z','2026-10-15T00:26:00Z',2),
  ('fx-restore-1','+819000000008','+815000000000','ended','2026-10-15T00:27:00Z','2026-10-15T00:28:00Z','2026-10-15T00:28:00Z',2),
  ('fx-purge-1','+819000000009','+815000000000','ended','2026-10-15T00:29:00Z','2026-10-15T00:30:00Z','2026-10-15T00:30:00Z',2);

INSERT INTO phone_messages(call_id,role,content,created_at) VALUES
  ('fx-first-1','user','こんにちは','2026-10-15T00:00:20Z'),
  ('fx-first-1','assistant','こんにちは。','2026-10-15T00:00:22Z'),
  ('fx-profile-1','user','前回の続きです','2026-10-15T00:02:20Z'),
  ('fx-profile-1','assistant','承知しました。','2026-10-15T00:02:22Z'),
  ('fx-multi-1','user','一回目','2026-10-15T00:21:20Z'),
  ('fx-multi-1','assistant','一回目です。','2026-10-15T00:21:22Z'),
  ('fx-multi-2','user','二回目','2026-10-15T00:23:20Z'),
  ('fx-multi-2','assistant','二回目です。','2026-10-15T00:23:22Z'),
  ('fx-trash-1','user','削除試験','2026-10-15T00:25:20Z'),
  ('fx-trash-1','assistant','削除試験です。','2026-10-15T00:25:22Z'),
  ('fx-restore-1','user','復元試験','2026-10-15T00:27:20Z'),
  ('fx-restore-1','assistant','復元試験です。','2026-10-15T00:27:22Z'),
  ('fx-purge-1','user','完全削除試験','2026-10-15T00:29:20Z'),
  ('fx-purge-1','assistant','完全削除試験です。','2026-10-15T00:29:22Z');

-- Large unprocessed transcript for backlog testing.
WITH RECURSIVE seq(n) AS (
  SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<30
)
INSERT INTO phone_messages(call_id,role,content,created_at)
SELECT 'fx-backlog-1',
       CASE WHEN n%2=1 THEN 'user' ELSE 'assistant' END,
       CASE WHEN n%2=1 THEN 'バックログ試験の本人発話 '||n ELSE 'バックログ試験の応答 '||n END,
       printf('2026-10-15T00:%02d:00Z',4+n/2)
FROM seq;

INSERT INTO phone_profiles(phone_number,display_name,personalization_text,memory_text,enabled,version,created_at,updated_at)
VALUES
  ('+819000000002','テスト利用者','短めに回答する','前回の会話がある',1,3,'2026-10-14T00:00:00Z','2026-10-15T00:03:00Z'),
  ('+819000000005','失敗試験','','',1,1,'2026-10-14T00:00:00Z','2026-10-14T00:00:00Z'),
  ('+819000000006','競合試験','','',1,7,'2026-10-14T00:00:00Z','2026-10-14T00:00:00Z'),
  ('+819000000007','ゴミ箱試験','','',1,1,'2026-10-14T00:00:00Z','2026-10-14T00:00:00Z'),
  ('+819000000008','復元試験','','',1,1,'2026-10-14T00:00:00Z','2026-10-14T00:00:00Z'),
  ('+819000000009','完全削除試験','','',1,1,'2026-10-14T00:00:00Z','2026-10-14T00:00:00Z');

INSERT INTO phone_memory_state(phone_number,last_processed_message_id,last_run_at,last_model,last_status,last_error,updated_at)
VALUES
  ('+819000000003',0,NULL,'','never','','2026-10-15T00:20:00Z'),
  ('+819000000006',0,'2026-10-15T00:31:00Z','fixture','version_conflict','profile version changed during extraction','2026-10-15T00:31:00Z');

INSERT INTO phone_memory_jobs(phone_number,trigger_call_id,status,mode,due_at,attempts,last_error,created_at,updated_at,completed_at)
VALUES
  ('+819000000005','fixture-failure','failed','shadow','2026-10-15T00:00:00Z',3,'fixture extractor failure','2026-10-15T00:00:00Z','2026-10-15T00:10:00Z','2026-10-15T00:10:00Z'),
  ('+819000000006','fixture-conflict','failed','active','2026-10-15T00:00:00Z',1,'version_conflict','2026-10-15T00:00:00Z','2026-10-15T00:31:00Z','2026-10-15T00:31:00Z');

UPDATE phone_calls SET lifecycle_state='trashed',trashed_at='2026-10-15T01:00:00Z' WHERE call_id IN ('fx-trash-1','fx-restore-1','fx-purge-1');
UPDATE phone_profiles SET lifecycle_state='trashed',trashed_at='2026-10-15T01:00:00Z' WHERE phone_number IN ('+819000000007','+819000000008','+819000000009');
INSERT INTO phone_user_trash(phone_number,trashed_at,reason) VALUES
  ('+819000000009','2026-10-15T01:00:00Z','fixture purge target');
