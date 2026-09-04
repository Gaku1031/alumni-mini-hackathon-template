-- 締め切った人＝立て替えた人。誰に払えばいいかを集計メッセージに出すために持つ。
-- 幹事は弁当を頼むとは限らない（頼むだけの人もいる）ので bento_orders からは引けない。
-- 表示名を text でそのまま持つ（ordered_by と同じ扱い）。
alter table bento_events add column closed_by text;
