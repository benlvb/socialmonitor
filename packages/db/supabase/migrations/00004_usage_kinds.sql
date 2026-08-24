-- Audit #14: /ask and weekly summaries were consuming the CLASSIFICATION
-- daily budget. Track classification calls separately; `calls`/`cost_usd`
-- remain the all-in totals the cap and dashboard use.
alter table llm_usage add column if not exists classify_calls int not null default 0;
